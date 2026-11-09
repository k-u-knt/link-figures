import type { AssetMap } from "../export/asset-types";
import type { Document, NodeId, Page, PageId } from "../model/types";
import type { Field } from "./fields";
import type { Registries } from "./index";

export interface ExportInput {
  doc: Document;
  pages: Page[];
  svgs: Map<PageId, string>;
  assets: Map<PageId, AssetMap>;
  /** For an exporter that has to build SVG again, a part of a page at a time (the PDF exporter's layers). */
  registries: Registries;
  /** The SVG builder's warnings; exporters pass these through in their result. */
  warnings: string[];
  baseName: string;
  dpi: number;
  /**
   * The nodes their plugin could not read when the figure was loaded (see `loadDocument`): an exporter that builds SVG
   * again passes them to `buildPageSvg`, and one that draws items itself skips them with `unreadableTypeWarning`.
   */
  unreadable?: ReadonlySet<NodeId>;
}

export interface ExportResult {
  files: { name: string; blob: Blob }[];
  warnings: string[];
}

export interface Exporter {
  id: string;
  name: string;
  ext: string;
  mime: string;
  /**
   * What the exporter embeds of a PDF panel: its page as vectors, or its raster. Trimming (see `trimAssets`) trims and
   * reports only that one.
   */
  pdfPanels: "vector" | "raster";
  options(): Field[];
  run(input: ExportInput, opts: Record<string, unknown>): Promise<ExportResult>;
}

export class ExporterRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly exporters = new Map<string, Exporter>();

  register(e: Exporter): void {
    this.exporters.set(e.id, e);
  }

  get(id: string): Exporter | undefined {
    return this.exporters.get(id);
  }

  all(): Exporter[] {
    return [...this.exporters.values()];
  }
}
