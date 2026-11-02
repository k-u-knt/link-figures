import { pageSizePx } from "../model/geometry";
import { nodeLabel } from "../model/labels";
import type { Document, Node, NodeId, Page } from "../model/types";
import type { Registries } from "../registry";
import type { SvgContext } from "../registry/node-type";
import type { AssetMap } from "./asset-types";

/** For a value written between double quotes. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface BuildOptions {
  /** Restrict the page to these nodes. */
  only?: Set<NodeId>;
  /** `false` leaves the paper rectangle out, for a transparent layer. */
  paper?: boolean;
}

/** A node's fragment, wrapped in a group when it is translucent or rotated (about its own centre). */
function wrap(node: Node, fragment: string): string {
  const attrs: string[] = [];
  if (node.opacity < 1) attrs.push(`opacity="${node.opacity}"`);
  if (node.rotation !== 0) attrs.push(`transform="rotate(${node.rotation} ${node.x + node.width / 2} ${node.y + node.height / 2})"`);
  return attrs.length === 0 ? fragment : `<g ${attrs.join(" ")}>${fragment}</g>`;
}

/**
 * One page as a standalone SVG document: `mm` size, a viewBox in the figure's own px, the paper, then the page's nodes by
 * `z`. Pure string work (no DOM), and numbers are written as they are, unrounded. Ids (`clip-1`, `clip-2`…) are unique
 * within the document and restart in each build.
 *
 * A node type that returns `"raster"` is drawn from the raster asset the caller made of it (see `collectAssets`).
 * What could not be drawn faithfully is reported in `warnings`: nodes that were rasterised, and nodes that were skipped.
 */
export function buildPageSvg(
  doc: Document,
  page: Page,
  registries: Registries,
  assets: AssetMap,
  opts: BuildOptions = {},
): { svg: string; warnings: string[] } {
  const size = pageSizePx(page);
  const defs: string[] = [];
  const warnings: string[] = [];
  const counters = new Map<string, number>();
  const ctx: SvgContext = {
    registries,
    doc,
    page,
    assets,
    defs,
    warnings,
    uid(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };

  // `sort` is stable, so nodes with the same `z` keep the document's order.
  const nodes = doc.nodes
    .filter((n) => n.page === page.id && (!opts.only || opts.only.has(n.id)))
    .sort((a, b) => a.z - b.z);

  const body: string[] = [];
  for (const node of nodes) {
    const type = registries.nodeTypes.get(node.type);
    if (!type) {
      warnings.push(`${nodeLabel(doc, node)}: no node type "${node.type}" is registered, skipped`);
      continue;
    }
    const before = warnings.length;
    let fragment = type.toSvg(node, ctx);
    if (fragment === "raster") {
      const asset = assets.get(node.id);
      if (asset?.kind !== "raster") {
        // A node type that already said why it has nothing to draw (a missing link) is not reported twice.
        if (warnings.length === before) warnings.push(`${nodeLabel(doc, node)}: not rasterised, skipped`);
        continue;
      }
      fragment =
        `<image href="${escapeAttr(asset.dataUri)}" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" ` +
        `preserveAspectRatio="none"/>`;
      warnings.push(`${nodeLabel(doc, node)} rasterised`);
    }
    body.push(wrap(node, fragment));
  }

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${size.width} ${size.height}">`,
  ];
  if (defs.length > 0) parts.push(`<defs>${defs.join("")}</defs>`);
  if (opts.paper !== false) parts.push(`<rect width="${size.width}" height="${size.height}" fill="${escapeAttr(page.paper)}"/>`);
  parts.push(...body, "</svg>");
  return { svg: parts.join("\n"), warnings };
}
