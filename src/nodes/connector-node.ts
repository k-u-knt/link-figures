import { resolveConnector } from "../connectors/geometry";
import type { Rect } from "../model/geometry";
import { nodeLabel } from "../model/labels";
import { toSvgPath } from "../model/path";
import type { ConnectorNode, Document, NodeId } from "../model/types";
import type { Field } from "../registry/fields";
import type { InspectorContext, NodeRenderer, NodeType, RenderContext, SvgContext } from "../registry/node-type";
import { paintToSvg, strokeAttrs, strokeFields } from "../registry/paint";

/**
 * What drawing a connector needs: the registries (its route, caps and paint) and the SVG it goes into. Warnings are said
 * without the node's label; the caller adds it.
 */
export type ConnectorSvgContext = Pick<SvgContext, "registries" | "defs" | "warnings" | "uid">;

const SVG_NS = "http://www.w3.org/2000/svg";

const END_NAMES = ["Start", "End"] as const;

const boxOf = (node: ConnectorNode): Rect => ({ x: node.x, y: node.y, width: node.width, height: node.height });

/**
 * A connector of `doc` as an SVG fragment, in page px, and the area it draws (`bounds`). The line is one `<path>` with
 * no fill, stroked with the connector's stroke; each cap is a `<path>` filled with the same paint. The paint is laid out
 * once, over the route's paint box, so a gradient runs along the line and on into its caps. A route or cap kind that is
 * not registered is drawn straight, or left out, and said so in `ctx.warnings`; the node keeps it as it is.
 */
export function connectorNodeSvg(doc: Document, node: ConnectorNode, ctx: ConnectorSvgContext): { svg: string; bounds: Rect } {
  const { paints, routes, caps } = ctx.registries;
  if (!routes.get(node.route)) ctx.warnings.push(`no route "${node.route}" is registered, drawn straight`);
  for (const cap of node.caps) {
    if (!caps.get(cap.kind)) ctx.warnings.push(`no cap kind "${cap.kind}" is registered, drawn without it`);
  }
  const resolved = resolveConnector(doc, node, ctx.registries);
  const paint = paintToSvg(paints, node.stroke.paint, resolved.paintBox, ctx);
  ctx.defs.push(...paint.defs);
  const parts = [`<path d="${toSvgPath(resolved.path)}" fill="none" ${strokeAttrs(node.stroke, paint.ref, paint.opacity)}/>`];
  const capOpacity = paint.opacity !== undefined && paint.opacity < 1 ? ` fill-opacity="${paint.opacity}"` : "";
  for (const cap of resolved.caps) {
    if (cap) parts.push(`<path d="${toSvgPath(cap)}" fill="${paint.ref}"${capOpacity}/>`);
  }
  return { svg: parts.join(""), bounds: resolved.bounds };
}

/** Stage renderers made so far: each one's ids start with its own number, so two connectors' gradients never share an id. */
let renderers = 0;

/**
 * One connector's DOM: `.lf-connector.lf-node` holding an inline `<svg>` whose viewBox is the area the connector draws,
 * so the fragment the export writes (`connectorNodeSvg`) is drawn as it is, with its own `<defs>`, and nothing of the
 * stroke or the caps is cut off. It is drawn from the document as it is now (`ctx.doc()`), so an update draws the
 * connector again after an item it is attached to has moved. What the drawing warns about is logged once, and again only
 * when it changes.
 */
class ConnectorNodeRenderer implements NodeRenderer {
  private readonly el: HTMLElement;
  private readonly idPrefix = `lf-connector-${++renderers}`;
  private warned = "";

  constructor(node: ConnectorNode, host: HTMLElement, private readonly ctx: RenderContext) {
    this.el = host.createDiv({ cls: ["lf-node", "lf-connector"] });
    this.update(node);
  }

  update(node: ConnectorNode): void {
    const defs: string[] = [];
    const warnings: string[] = [];
    const counters = new Map<string, number>();
    const uid = (prefix: string): string => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${this.idPrefix}-${prefix}-${n}`;
    };
    const { svg, bounds } = connectorNodeSvg(this.ctx.doc(), node, { registries: this.ctx.registries, defs, warnings, uid });
    const said = warnings.join("\n");
    if (said !== "" && said !== this.warned) console.warn(`Link Figures: connector ${node.id}: ${warnings.join("; ")}`);
    this.warned = said;

    // The bounds are never empty; the floor only keeps a malformed one from making an empty viewBox.
    const width = Math.max(bounds.width, 1);
    const height = Math.max(bounds.height, 1);
    const style = this.el.style;
    style.left = `${bounds.x}px`;
    style.top = `${bounds.y}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.zIndex = String(node.z);
    style.opacity = node.opacity === 1 ? "" : String(node.opacity);

    const markup =
      `<svg xmlns="${SVG_NS}" viewBox="${bounds.x} ${bounds.y} ${width} ${height}" preserveAspectRatio="none">` +
      `${defs.length > 0 ? `<defs>${defs.join("")}</defs>` : ""}${svg}</svg>`;
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (parsed.getElementsByTagName("parsererror").length > 0) {
      console.error(`Link Figures: could not draw connector ${node.id}`);
      this.el.replaceChildren();
      return;
    }
    this.el.replaceChildren(this.el.ownerDocument.importNode(parsed.documentElement, true));
  }

  unmount(): void {
    this.el.remove();
  }
}

/** A registry's entries as select options, with `current` added (by its id) when it is not one of them, so the select still names it. */
function optionsOf(entries: { id: string; name: string }[], current: string): { value: string; label: string }[] {
  const options = entries.map((e) => ({ value: e.id, label: e.name }));
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }];
}

const SNAP_OPTIONS = [
  { value: "anchor", label: "Anchor" },
  { value: "center", label: "Centre" },
];

/**
 * A line between two ends, each free or attached to an item, drawn by any registered route and capped by any registered
 * cap kinds (all found through the context's registries). Its box is the area it draws and it is never rotated: the
 * store's connector normaliser keeps both so, which is why the inspector offers neither. Its inspector is the route, the
 * route's own fields (under `routeParams.`), the line's stroke, each cap's kind and size, and each attached end's snap.
 * A connector cannot be attached to.
 */
export const connectorNodeType: NodeType<ConnectorNode> = {
  type: "connector",
  name: "Connector",
  icon: "move-up-right",
  derivedFields: ["x", "y", "width", "height", "rotation"],

  mount(node: ConnectorNode, host: HTMLElement, ctx: RenderContext): NodeRenderer {
    return new ConnectorNodeRenderer(node, host, ctx);
  },

  bounds: boxOf,

  dependsOn(node: ConnectorNode): NodeId[] {
    return node.ends.flatMap((end) => (end.kind === "attached" ? [end.node] : []));
  },

  inspector(node: ConnectorNode, ctx: InspectorContext): Field[] {
    const { routes, caps } = ctx.registries;
    const route = routes.get(node.route);
    const routeFields = route ? route.fields(node.routeParams).map((f) => ({ ...f, key: `routeParams.${f.key}` })) : [];
    const capFields = ([0, 1] as const).flatMap((i): Field[] => [
      { kind: "select", key: `caps.${i}.kind`, label: `${END_NAMES[i]} cap`, options: optionsOf(caps.all(), node.caps[i].kind) },
      { kind: "number", key: `caps.${i}.size`, label: `${END_NAMES[i]} cap size`, min: 0, step: 0.5 },
    ]);
    const snapFields = ([0, 1] as const).flatMap((i): Field[] =>
      node.ends[i].kind === "attached" ? [{ kind: "select", key: `ends.${i}.snap`, label: `${END_NAMES[i]} snap`, options: SNAP_OPTIONS }] : [],
    );
    return [
      { kind: "select", key: "route", label: "Route", options: optionsOf(routes.all(), node.route) },
      ...routeFields,
      ...strokeFields("stroke", "Line"),
      ...capFields,
      ...snapFields,
    ];
  },

  toSvg(node: ConnectorNode, ctx: SvgContext): string {
    const warnings: string[] = [];
    const { svg } = connectorNodeSvg(ctx.doc, node, { registries: ctx.registries, defs: ctx.defs, warnings, uid: (prefix) => ctx.uid(prefix) });
    for (const warning of warnings) ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: ${warning}`);
    return svg;
  },
};
