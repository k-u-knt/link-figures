import type { NodeId } from "../model/types";

export interface ImageAsset {
  kind: "image";
  dataUri: string;
  naturalWidth: number;
  naturalHeight: number;
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
}

/** A node rendered to a raster by the DOM, for node types whose `toSvg` returns `"raster"`. */
export interface RasterAsset {
  kind: "raster";
  dataUri: string;
}

export type FileAsset = ImageAsset | SvgAsset | PdfAsset;

export type AssetMap = Map<NodeId, FileAsset | RasterAsset>;
