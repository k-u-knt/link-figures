import { Modal, Notice, Setting, type ButtonComponent, type TextComponent } from "obsidian";
import { MAX_DPI, MIN_DPI } from "../constants";
import type { Page, PageId } from "../model/types";
import type { Exporter } from "../registry/exporter";
import type { LinkFiguresView } from "../view/figure-view";
import { COMMON_EXPORT_OPTIONS } from "./export-options";
import { DPI_PRESETS, exportFigure, exportSummary, optionDefaults, type FigureExportTarget } from "./export-run";
import { browserTrimDeps } from "./trim";
import { isFigureSource } from "./write";

export { exportSummary, runExport, type ExportDeps, type ExportRun } from "./export-run";

/** More report lines than this are summarised in the notice; all of them go to the console. */
const MAX_WARNINGS_SHOWN = 12;
const WARNING_NOTICE_MS = 15_000;

function warningsNotice(warnings: string[]): Notice {
  const shown = warnings.slice(0, MAX_WARNINGS_SHOWN);
  const fragment = createFragment((el) => {
    el.createEl("div", { text: "Export report:" });
    for (const warning of shown) el.createEl("div", { text: warning });
    if (warnings.length > shown.length) el.createEl("div", { text: `…and ${warnings.length - shown.length} more (see the developer console)` });
  });
  return new Notice(fragment, WARNING_NOTICE_MS);
}

/**
 * What the export of a figure open in `view` needs: its document, the page in focus (`current`, else the view's own),
 * and the plugin's settings, decoders and trimming. No file may replace the figure or one of its sources.
 */
export function viewExportTarget(view: LinkFiguresView, file: { path: string }, current?: Page): FigureExportTarget {
  const plugin = view.plugin;
  return {
    figurePath: file.path,
    baseName: view.getDisplayText(),
    doc: view.store.doc,
    currentPage: current ?? view.focusPage(),
    settings: plugin.settings,
    deps: {
      app: view.app,
      registries: plugin.registries,
      resolved: (id) => view.resolvedCache.get(id),
      elementFor: (id) => view.nodeHost.elementFor(id),
      decoders: plugin.decoders,
      trim: browserTrimDeps,
      isProtected: (path, cardsFile) => isFigureSource(path, file.path, (p) => view.index.has(p), cardsFile),
      // Note cards are read from the vault, not from the stage, so a figure exported in the background has them too.
      access: plugin.access,
    },
    drawn: () => view.nodeHost.drawn(),
    // As the view loaded the figure (an export opened in the background loads it too).
    unreadable: view.unreadableNodes,
  };
}

/** Export options for a figure: the format and its own options, which pages, and the resolution of what has to be rasterised. */
export class ExportModal extends Modal {
  private readonly pageId: PageId;
  private formatId: string;
  private pageChoice: "current" | "all" = "current";
  private dpiText: string;
  /** The chosen format's options, as its fields show them (each starts at its default: see `optionDefaults`). */
  private optionValues: Record<string, unknown> = {};
  private optionsEl: HTMLElement | null = null;
  /** Where the options placed at the end go (`Field.placement`). */
  private endOptionsEl: HTMLElement | null = null;
  private busy = false;

  /** The export dialog that is open, if one is: there is never more than one (see `show`). */
  private static shown: ExportModal | null = null;

  /** The export dialog that is open, or null. */
  static openDialog(): ExportModal | null {
    return ExportModal.shown;
  }

  /**
   * Opens the export dialog for `view`; when one is already open (for any figure), that one is kept and focused
   * instead of a second being stacked on it. Returns the dialog shown.
   */
  static show(view: LinkFiguresView): ExportModal {
    const open = ExportModal.shown;
    if (open) {
      open.focus();
      return open;
    }
    const modal = new ExportModal(view);
    modal.open();
    return modal;
  }

  constructor(private readonly view: LinkFiguresView) {
    super(view.app);
    // The page the user is looking at when they ask, not wherever the view has moved to when they press Export.
    this.pageId = view.focusPage().id;
    this.formatId = view.plugin.registries.exporters.all()[0]?.id ?? "";
    this.dpiText = String(view.plugin.settings.exportDpi);
  }

  onOpen(): void {
    ExportModal.shown = this;
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
        this.renderOptions();
      });
    });
    this.optionsEl = contentEl.createDiv({ cls: "lf-export-options" });

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

    let dpiInput: TextComponent | null = null;
    const resolution = new Setting(contentEl)
      .setName("Resolution (dpi)")
      .setDesc("For what is drawn as pixels: PDF pages and note content, and the whole page in PNG and TIFF.")
      .addText((text) => {
        dpiInput = text;
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_DPI);
        text.inputEl.max = String(MAX_DPI);
        text.inputEl.step = "1";
        text.setValue(this.dpiText).onChange((value) => {
          this.dpiText = value;
        });
      });
    for (const preset of DPI_PRESETS) {
      resolution.addButton((button) =>
        button.setButtonText(String(preset)).onClick(() => {
          this.dpiText = String(preset);
          dpiInput?.setValue(this.dpiText);
        }),
      );
    }

    // The options placed at the end (`Field.placement`: the cards options), after Pages and Resolution.
    this.endOptionsEl = contentEl.createDiv({ cls: "lf-export-options" });
    this.renderOptions();

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Export")
        .setCta()
        .onClick(() => void this.exportNow(button)),
    );
  }

  onClose(): void {
    if (ExportModal.shown === this) ExportModal.shown = null;
    this.contentEl.empty();
    this.optionsEl = null;
    this.endOptionsEl = null;
  }

  /** Brings the keyboard back to the dialog: its first control, else the dialog itself. */
  private focus(): void {
    const first = this.modalEl.querySelector<HTMLElement>("select, input, button");
    (first ?? this.modalEl).focus();
  }

  /** The chosen format's options, under the Format menu, then the options every format has, each at its default; those placed at the end (`Field.placement`) after Resolution. */
  private renderOptions(): void {
    const top = this.optionsEl;
    const end = this.endOptionsEl;
    if (!top || !end) return;
    top.empty();
    end.empty();
    const exporter: Exporter | undefined = this.view.plugin.registries.exporters.get(this.formatId);
    const fields = [...(exporter?.options() ?? []), ...COMMON_EXPORT_OPTIONS];
    this.optionValues = optionDefaults(fields);
    for (const field of fields) {
      if (!(field.key in this.optionValues)) continue;
      const setting = new Setting(field.placement === "end" ? end : top).setName(field.label);
      const set = (value: unknown) => {
        this.optionValues[field.key] = value;
      };
      const value = this.optionValues[field.key];
      if (field.kind === "select") {
        setting.addDropdown((dropdown) => {
          for (const option of field.options ?? []) dropdown.addOption(option.value, option.label);
          dropdown.setValue(String(value)).onChange(set);
        });
      } else if (field.kind === "toggle") {
        // A toggle with an `onValue` is on while its value is that ("cards": "markdown"), and null when off.
        const onValue = field.onValue;
        if (onValue !== undefined) setting.addToggle((toggle) => toggle.setValue(value !== null && value !== undefined).onChange((on) => set(on ? onValue : null)));
        else setting.addToggle((toggle) => toggle.setValue(value === true).onChange(set));
      } else if (field.kind === "number") {
        setting.addText((text) => {
          text.inputEl.type = "number";
          if (field.min !== undefined) text.inputEl.min = String(field.min);
          if (field.max !== undefined) text.inputEl.max = String(field.max);
          if (field.step !== undefined) text.inputEl.step = String(field.step);
          text.setValue(String(value)).onChange((typed) => set(Number(typed)));
        });
      } else {
        setting.addText((text) => text.setValue(String(value)).onChange(set));
      }
    }
  }

  private currentPage(): Page | undefined {
    const pages = this.view.store.doc.pages;
    return pages.find((p) => p.id === this.pageId) ?? pages[0];
  }

  private async exportNow(button: ButtonComponent): Promise<void> {
    if (this.busy) return;
    const { view } = this;
    const exporter = view.plugin.registries.exporters.get(this.formatId);
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
      const { files, warnings, folder } = await exportFigure(viewExportTarget(view, file, this.currentPage()), {
        format: exporter.id,
        pages: this.pageChoice,
        dpi,
        options: this.optionValues,
      });
      new Notice(exportSummary(files.length, folder));
      if (warnings.length > 0) {
        console.warn("Link Figures: export report", warnings);
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
