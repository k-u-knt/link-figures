import type { Rect } from "../../model/geometry";
import { nodeLabel } from "../../model/labels";
import type { Document, FileNode, Page } from "../../model/types";
import type { AssetMap, FileAsset, ImageAsset, PdfAsset, SvgAsset } from "../asset-types";
import { svgIntrinsicSize } from "../inline-svg";
import { cutImageOnCanvas, cutRaster, type CutImage } from "./raster";
import { fromFraction, isWhollyVisible, toFraction, visibleSourceRect } from "./visible";

export type { PixelRect } from "./visible";

/** What trimming needs from outside: the browser, for rasters, and the trimmers of SVG and PDF sources. */
export interface TrimDeps {
  cutImage: CutImage;
  /** `visible` is in the SVG's viewBox units. */
  trimSvg(text: string, visible: Rect): Promise<{ text: string; removed: number }>;
  /** `visible` is in points of the page, from its top-left corner. `notes` are reported as `{label}: {note}`. */
  trimPdf(bytes: ArrayBuffer, pageIndex: number, visible: Rect): Promise<{ bytes: Uint8Array; removed: number; notes: string[] }>;
}

/** The trimmers the export uses. SVG and PDF sources are passed through until their trimmers land. */
export const browserTrimDeps: TrimDeps = {
  cutImage: cutImageOnCanvas,
  trimSvg: async (text) => ({ text, removed: 0 }),
  trimPdf: async (bytes) => ({ bytes: new Uint8Array(bytes), removed: 0, notes: [] }),
};

const NOTHING_OUTSIDE = "nothing lay wholly outside the crop";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removedLine(removed: number): string {
  return removed === 0 ? NOTHING_OUTSIDE : `${removed} item${removed === 1 ? "" : "s"} outside the crop removed`;
}

/** What a raster cut kept. Not "the crop": an uncropped `cover` panel is cut too. */
function cutLine(cut: { width: number; height: number }, natural: { width: number; height: number }): string {
  return `cut to what shows (${cut.width} × ${cut.height} of ${natural.width} × ${natural.height} px)`;
}

/** The node's visible region as a fraction of its source, or `null` when all of the source shows. */
function visibleFraction(node: FileNode, natural: { width: number; height: number }): Rect | null {
  const visible = visibleSourceRect({ width: node.width, height: node.height }, natural, node.crop, node.fit);
  return isWhollyVisible(visible, natural) ? null : toFraction(visible, natural);
}

/** `bytes` as an `ArrayBuffer` of exactly its own bytes. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function trimImage(asset: ImageAsset, node: FileNode, visible: Rect, deps: TrimDeps, say: (line: string) => void): Promise<FileAsset> {
  const natural = { width: asset.naturalWidth, height: asset.naturalHeight };
  const cut = await cutRaster(asset.dataUri, natural, node.crop, visible, deps.cutImage);
  if (!cut) {
    say(NOTHING_OUTSIDE);
    return asset;
  }
  say(cutLine(cut, natural));
  return { ...asset, dataUri: cut.dataUri, naturalWidth: cut.width, naturalHeight: cut.height, crop: cut.crop };
}

async function trimSvgAsset(asset: SvgAsset, visible: Rect, deps: TrimDeps, say: (line: string) => void): Promise<FileAsset> {
  const [vx, vy, vw, vh] = svgIntrinsicSize(asset.text).viewBox;
  const inViewBox = fromFraction(visible, { width: vw, height: vh });
  const trimmed = await deps.trimSvg(asset.text, { ...inViewBox, x: vx + inViewBox.x, y: vy + inViewBox.y });
  say(removedLine(trimmed.removed));
  return trimmed.removed === 0 ? asset : { ...asset, text: trimmed.text };
}

/**
 * A PDF panel has two sources: its page, which a `"vector"` exporter embeds, and its raster, which a `"raster"` one
 * draws. Only the one the exporter embeds is trimmed (the page in points, the raster in its pixels) and reported.
 */
async function trimPdfAsset(
  asset: PdfAsset,
  node: FileNode,
  visible: Rect,
  pdfPanels: "vector" | "raster",
  deps: TrimDeps,
  say: (line: string) => void,
): Promise<FileAsset> {
  if (pdfPanels === "raster") {
    const natural = { width: asset.rasterWidth, height: asset.rasterHeight };
    const cut = await cutRaster(asset.raster, natural, node.crop, visible, deps.cutImage);
    if (!cut) {
      say(NOTHING_OUTSIDE);
      return asset;
    }
    say(cutLine(cut, natural));
    return { ...asset, raster: cut.dataUri, rasterWidth: cut.width, rasterHeight: cut.height, rasterCrop: cut.crop };
  }
  const points = fromFraction(visible, { width: asset.widthPt, height: asset.heightPt });
  const trimmed = await deps.trimPdf(asset.bytes, asset.pageIndex, points);
  say(removedLine(trimmed.removed));
  for (const note of trimmed.notes) say(note);
  return trimmed.removed === 0 ? asset : { ...asset, bytes: ownBuffer(trimmed.bytes) };
}

/**
 * The page's assets with each panel's source trimmed to the part of it that shows (see `visibleSourceRect`): rasters
 * cut, SVG and PDF sources stripped of what lies wholly outside. A panel whose whole source shows keeps its asset
 * object, untouched, and gets no line in `report`; every other panel gets at least one, `{label}: …`. A panel that
 * cannot be trimmed keeps its asset whole, with the reason. `pdfPanels` is what the exporter embeds of a PDF panel
 * (see `Exporter.pdfPanels`). Returns a new map; `assets` is not changed.
 */
export async function trimAssets(
  doc: Document,
  page: Page,
  assets: AssetMap,
  deps: TrimDeps,
  report: string[],
  pdfPanels: "vector" | "raster",
): Promise<AssetMap> {
  const out: AssetMap = new Map(assets);
  for (const node of doc.nodes) {
    if (node.page !== page.id || node.type !== "file" || node.show === "content") continue;
    const asset = assets.get(node.id);
    if (!asset || asset.kind === "raster") continue;
    const label = nodeLabel(doc, node);
    const say = (line: string) => report.push(`${label}: ${line}`);
    try {
      switch (asset.kind) {
        case "image": {
          const visible = visibleFraction(node, { width: asset.naturalWidth, height: asset.naturalHeight });
          if (visible) out.set(node.id, await trimImage(asset, node, visible, deps, say));
          break;
        }
        case "svg": {
          const [, , vw, vh] = svgIntrinsicSize(asset.text).viewBox;
          const visible = visibleFraction(node, { width: vw, height: vh });
          if (visible) out.set(node.id, await trimSvgAsset(asset, visible, deps, say));
          break;
        }
        case "pdf": {
          const visible = visibleFraction(node, { width: asset.widthPt, height: asset.heightPt });
          if (visible) out.set(node.id, await trimPdfAsset(asset, node, visible, pdfPanels, deps, say));
          break;
        }
      }
    } catch (error) {
      say(`could not be trimmed, embedded whole (${reasonOf(error)})`);
    }
  }
  return out;
}
