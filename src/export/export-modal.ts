import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import { MAX_DPI, MIN_DPI } from "../constants";
import type { Resolved } from "../links/types";
import type { Document, NodeId, Page, PageId } from "../model/types";
import type { NodeTypeRegistry } from "../registry/node-type";
import type { Exporter } from "../registry/exporter";
import type { LinkFiguresView } from "../view/figure-view";
import type { AssetMap } from "./asset-types";
import { collectAssets } from "./assets";
import { buildPageSvg } from "./svg-builder";
import { exportDir, exportFolderFor, exportPathFor, isFigureSource, safeFileName, uniqueFileNames, writeExportFile } from "./write";

/** More warnings than this are summarised in the notice; all of them go to the console. */
const MAX_WARNINGS_SHOWN = 12;
const WARNING_NOTICE_MS = 15_000;

export interface ExportRun {
  exporter: Exporter;
  doc: Document;
  pages: Page[];
  /** The figure's file name without `.lnkfig.md`. */
  baseName: string;
  /** Vault folder the files are written to; `""` is the vault root. */
  folder: string;
  dpi: number;
  /** Pages larger than this (mm, either side) are still exported, with a warning. */
  maxPageSizeMm: number;
}

export interface ExportDeps {
  app: App;
  nodeTypes: NodeTypeRegistry;
  resolved: (id: NodeId) => Resolved | undefined;
  elementFor: (id: NodeId) => HTMLElement | undefined;
  /** True for a vault path no export may write over: the figure file and its sources (see `isFigureSource`). */
  isProtected: (path: string) => boolean;
}

/**
 * Collects each page's assets, builds its SVG, lets the exporter turn them into files and writes those to the vault.
 * The warnings returned are everything that could not be done faithfully: assets that failed, nodes skipped, nodes rasterised,
 * and files not written because their path is protected (`deps.isProtected`). `files` counts the files actually written.
 */
export async function runExport(run: ExportRun, deps: ExportDeps): Promise<{ files: number; warnings: string[] }> {
  const { app } = deps;
  const warnings: string[] = [];
  const svgs = new Map<PageId, string>();
  const assets = new Map<PageId, AssetMap>();

  const fileAt = (path: string) => {
    const file = app.vault.getFileByPath(path);
    if (!file) throw new Error(`File not found in vault: ${path}`);
    return file;
  };

  for (const page of run.pages) {
    if (page.width > run.maxPageSizeMm || page.height > run.maxPageSizeMm) {
      warnings.push(`Page "${page.name}" is ${page.width} × ${page.height} mm, over the ${run.maxPageSizeMm} mm page limit`);
    }
    const pageAssets = await collectAssets(run.doc, page, {
      app,
      resolved: deps.resolved,
      elementFor: deps.elementFor,
      readBinary: (path) => app.vault.readBinary(fileAt(path)),
      readText: (path) => app.vault.cachedRead(fileAt(path)),
      dpi: run.dpi,
      warnings,
    });
    const built = buildPageSvg(run.doc, page, deps.nodeTypes, pageAssets);
    warnings.push(...built.warnings);
    assets.set(page.id, pageAssets);
    svgs.set(page.id, built.svg);
  }

  const result = await run.exporter.run(
    { doc: run.doc, pages: run.pages, svgs, assets, nodeTypes: deps.nodeTypes, warnings, baseName: run.baseName, dpi: run.dpi },
    {},
  );

  // Two files of one run with the same name (two pages called "Page 2", or "A/B" and "A:B") would be one file on disk,
  // the second written over the first: they are told apart here, whichever exporter made them.
  const names = uniqueFileNames(result.files.map((file) => file.name));
  const reported = [...result.warnings];
  result.files.forEach((file, i) => {
    if (names[i] !== safeFileName(file.name)) reported.push(`Page name '${file.name}' is used more than once; wrote '${names[i]}'`);
  });
  let written = 0;
  for (const [i, file] of result.files.entries()) {
    // An export named like one of the figure's sources ("Figure 2.pdf" beside a plot of that name) must not replace it;
    // writing over an earlier export is routine and stays silent.
    const path = exportPathFor(run.folder, names[i]);
    if (deps.isProtected(path)) {
      reported.push(`Refused to overwrite ${path}: it is a source of this figure`);
      continue;
    }
    await writeExportFile(app, run.folder, names[i], file.blob);
    written++;
  }
  return { files: written, warnings: reported };
}

/** The success message: how many files were written, and to which folder. */
export function exportSummary(files: number, folder: string): string {
  return `Exported ${files} file(s) to ${exportDir(folder) || "the vault root"}`;
}

function warningsNotice(warnings: string[]): Notice {
  const shown = warnings.slice(0, MAX_WARNINGS_SHOWN);
  const fragment = createFragment((el) => {
    el.createEl("div", { text: "Export warnings:" });
    for (const warning of shown) el.createEl("div", { text: warning });
    if (warnings.length > shown.length) el.createEl("div", { text: `…and ${warnings.length - shown.length} more (see the developer console)` });
  });
  return new Notice(fragment, WARNING_NOTICE_MS);
}

/** Export options for a figure: the format, which pages, and the resolution of what has to be rasterised. */
export class ExportModal extends Modal {
  private readonly pageId: PageId;
  private formatId: string;
  private pageChoice: "current" | "all" = "current";
  private dpiText: string;
  private busy = false;

  constructor(private readonly view: LinkFiguresView) {
    super(view.app);
    // The page the user is looking at when they ask, not wherever the view has moved to when they press Export.
    this.pageId = view.focusPage().id;
    this.formatId = view.plugin.registries.exporters.all()[0]?.id ?? "";
    this.dpiText = String(view.plugin.settings.exportDpi);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Export figure");
    contentEl.empty();

    const exporters = this.view.plugin.registries.exporters.all();
    if (exporters.length === 0) {
      contentEl.createEl("p", { text: "No export formats are available." });
      return;
    }

    new Setting(contentEl).setName("Format").addDropdown((dropdown) => {
      for (const exporter of exporters) dropdown.addOption(exporter.id, exporter.name);
      dropdown.setValue(this.formatId);
      dropdown.onChange((value) => {
        this.formatId = value;
      });
    });

    const pages = new Setting(contentEl).setName("Pages").setDesc(`The current page is "${this.currentPage()?.name ?? ""}".`);
    const group = "lf-export-pages";
    for (const [value, label] of [
      ["current", "Current page"],
      ["all", "All pages"],
    ] as const) {
      const row = pages.controlEl.createDiv().createEl("label");
      const radio = row.createEl("input", { type: "radio", attr: { name: group, value } });
      radio.checked = this.pageChoice === value;
      radio.addEventListener("change", () => {
        if (radio.checked) this.pageChoice = value;
      });
      row.createSpan({ text: ` ${label}` });
    }

    new Setting(contentEl)
      .setName("Resolution (dpi)")
      .setDesc("For what is drawn as pixels: PDF pages and note content.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_DPI);
        text.inputEl.max = String(MAX_DPI);
        text.inputEl.step = "1";
        text.setValue(this.dpiText).onChange((value) => {
          this.dpiText = value;
        });
      });

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Export")
        .setCta()
        .onClick(() => void this.exportNow(button)),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private currentPage(): Page | undefined {
    const pages = this.view.store.doc.pages;
    return pages.find((p) => p.id === this.pageId) ?? pages[0];
  }

  private async exportNow(button: ButtonComponent): Promise<void> {
    if (this.busy) return;
    const { view } = this;
    const plugin = view.plugin;
    const exporter = plugin.registries.exporters.get(this.formatId);
    const file = view.file;
    const dpi = Number(this.dpiText);
    if (!exporter || !file) {
      new Notice("Link Figures: nothing to export with. Open a figure and choose a format.");
      return;
    }
    if (this.dpiText.trim() === "" || !Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
      new Notice(`Link Figures: the resolution must be a number from ${MIN_DPI} to ${MAX_DPI} dpi.`);
      return;
    }

    this.busy = true;
    button.setDisabled(true).setButtonText("Exporting…");
    try {
      const doc = view.store.doc;
      const current = this.currentPage();
      const pages = this.pageChoice === "all" ? doc.pages : current ? [current] : [];
      const folder = exportFolderFor(plugin.settings, file.path);
      const { files, warnings } = await runExport(
        { exporter, doc, pages, baseName: view.getDisplayText(), folder, dpi: Math.round(dpi), maxPageSizeMm: plugin.settings.maxPageSizeMm },
        {
          app: view.app,
          nodeTypes: plugin.registries.nodeTypes,
          resolved: (id) => view.resolvedCache.get(id),
          elementFor: (id) => view.nodeHost.elementFor(id),
          isProtected: (path) => isFigureSource(path, file.path, (p) => view.index.has(p)),
        },
      );
      new Notice(exportSummary(files, folder));
      if (warnings.length > 0) {
        console.warn("Link Figures: export warnings", warnings);
        warningsNotice(warnings);
      }
      this.close();
    } catch (error) {
      console.error("Link Figures: export failed", error);
      new Notice(`Link Figures: export failed. ${error instanceof Error ? error.message : String(error)}`);
      button.setDisabled(false).setButtonText("Export");
    } finally {
      this.busy = false;
    }
  }
}
