import type { Crop, NodeId } from "../model/types";

export interface ImageAsset {
  kind: "image";
  dataUri: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Set by trimming: the panel's crop re-expressed in this (cut) image, drawn instead of the node's. May reach outside 0–1. */
  crop?: Crop;
}

export interface SvgAsset {
  kind: "svg";
  text: string;
  width: number;
  height: number;
}

export interface PdfAsset {
  kind: "pdf";
  bytes: ArrayBuffer;
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  raster: string;
  rasterWidth: number;
  rasterHeight: number;
  /** Set by trimming: the panel's crop re-expressed in the (cut) raster, drawn instead of the node's. May reach outside 0–1. */
  rasterCrop?: Crop;
}

/** A node rendered to a raster by the DOM, for node types whose `toSvg` returns `"raster"`. */
export interface RasterAsset {
  kind: "raster";
  dataUri: string;
}

export type FileAsset = ImageAsset | SvgAsset | PdfAsset;

export type AssetMap = Map<NodeId, FileAsset | RasterAsset>;
