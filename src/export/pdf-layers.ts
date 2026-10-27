import { PX_TO_PT } from "../constants";
import { pageSizePx } from "../model/geometry";
import type { FileNode, Node, NodeId, Page } from "../model/types";

/** One run of the page's nodes, in z order: a stretch drawn by svg2pdf, or one PDF panel drawn as the source's own page. */
export type Layer = { kind: "svg"; nodeIds: NodeId[] } | { kind: "pdf"; nodeId: NodeId };

/**
 * The page's nodes by `z` (the SVG builder's order: nodes with the same `z` keep their order) cut at each PDF panel.
 * The first layer is always an SVG layer, empty when a PDF panel is the lowest node or there are no nodes, so the paper
 * rectangle, which only the first layer draws, always has a layer to be drawn in.
 */
export function splitLayers(nodes: Node[], isPdfPanel: (n: Node) => boolean): Layer[] {
  const layers: Layer[] = [{ kind: "svg", nodeIds: [] }];
  for (const node of [...nodes].sort((a, b) => a.z - b.z)) {
    const last = layers[layers.length - 1];
    if (isPdfPanel(node)) layers.push({ kind: "pdf", nodeId: node.id });
    else if (last.kind === "svg") last.nodeIds.push(node.id);
    else layers.push({ kind: "svg", nodeIds: [node.id] });
  }
  return layers;
}

/** Where and how a PDF panel's source page is drawn, in pt, in PDF's coordinates (origin bottom-left, y up). */
export interface PdfPlacement {
  /** The bottom-left corner of the drawn page before it is rotated (pdf-lib turns a page about this corner). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, counter-clockwise, for `degrees()`. */
  rotate: number;
  /** The part of the source page to embed: the whole page, or the crop. */
  box: { left: number; bottom: number; right: number; top: number };
}

/**
 * The panel as a PDF page placed on the exported page. The part of the source that shows (the crop, or all of it) is
 * scaled to the node's rectangle as `fit` says, as `imagePlacement` does for rasters: `cover` fills the rectangle and cuts
 * the overflow off the embedded `box`, so nothing outside the node is drawn; `contain` draws all of it, centred. A
 * rotation is about the node's centre and the opposite way round, since PDF angles are counter-clockwise while the
 * figure's are clockwise.
 *
 * `src` is the source page's size in pt, and `box` is measured from its bottom-left corner.
 */
export function pdfPanelPlacement(node: FileNode, page: Page, src: { widthPt: number; heightPt: number }): PdfPlacement {
  const nodeW = node.width * PX_TO_PT;
  const nodeH = node.height * PX_TO_PT;
  const nodeCentre = {
    x: (node.x + node.width / 2) * PX_TO_PT,
    y: pageSizePx(page).height * PX_TO_PT - (node.y + node.height / 2) * PX_TO_PT,
  };

  // The crop is measured from the top of the source, the box from its bottom.
  const crop = node.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const region = {
    left: crop.x * src.widthPt,
    bottom: (1 - crop.y - crop.h) * src.heightPt,
    right: (crop.x + crop.w) * src.widthPt,
    top: (1 - crop.y) * src.heightPt,
  };
  const regionW = region.right - region.left;
  const regionH = region.top - region.bottom;

  const scaleX = nodeW / regionW;
  const scaleY = nodeH / regionH;
  let box = region;
  let width: number;
  let height: number;
  if (node.fit === "cover") {
    // The axis that needs the larger scale shows all of the region; the other shows only as much as fits the node, centred.
    // (The limiting axis keeps the region's own numbers, so a matching aspect is not nudged by rounding.)
    const shownW = scaleX >= scaleY ? regionW : nodeW / scaleY;
    const shownH = scaleX >= scaleY ? nodeH / scaleX : regionH;
    const cutX = (regionW - shownW) / 2;
    const cutY = (regionH - shownH) / 2;
    box = { left: region.left + cutX, bottom: region.bottom + cutY, right: region.right - cutX, top: region.top - cutY };
    width = nodeW;
    height = nodeH;
  } else {
    const scale = Math.min(scaleX, scaleY);
    width = regionW * scale;
    height = regionH * scale;
  }

  // The turn is about the drawn page's centre, which is the node's centre; pdf-lib turns about the bottom-left corner,
  // so that corner goes where the turn puts it relative to the centre.
  const rotate = 0 - node.rotation;
  const angle = (rotate * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: nodeCentre.x - ((width / 2) * cos - (height / 2) * sin),
    y: nodeCentre.y - ((width / 2) * sin + (height / 2) * cos),
    width,
    height,
    rotate,
    box,
  };
}
