import type { AssetMap } from "../export/asset-types";
import type { Document, Page, PageId } from "../model/types";
import type { Field } from "./fields";

export interface ExportInput {
  doc: Document;
  pages: Page[];
  svgs: Map<PageId, string>;
  assets: Map<PageId, AssetMap>;
  /** The SVG builder's warnings; exporters pass these through in their result. */
  warnings: string[];
  baseName: string;
  dpi: number;
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
