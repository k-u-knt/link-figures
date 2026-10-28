import { PluginSettingTab, Setting, type App } from "obsidian";
import { MAX_DPI, MIN_DPI } from "../constants";
import type LinkFiguresPlugin from "../main";
import { PAGE_PRESETS, getPreset } from "../model/presets";

export interface LinkFiguresSettings {
  /** Where OS drops and pasted images are saved; "" uses Obsidian's own attachment setting. */
  attachmentFolder: string;
  /** Open files carrying the `link-figures` frontmatter marker in the figure view. */
  openAsFigure: boolean;
  /** Page preset id for new figures. */
  defaultPreset: string;
  /** Where exports are written; "" puts them next to the figure. */
  exportFolder: string;
  exportDpi: number;
}

export const DEFAULT_SETTINGS: LinkFiguresSettings = {
  attachmentFolder: "",
  openAsFigure: true,
  defaultPreset: "nature-double",
  exportFolder: "",
  exportDpi: 300,
};

export class LinkFiguresSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: LinkFiguresPlugin) {
    super(app, owner);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.owner.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Open figure files as figures")
      .setDesc("Open notes that carry the link-figures frontmatter key in the figure view. The \"Open as markdown\" command still shows the source.")
      .addToggle((toggle) =>
        toggle.setValue(settings.openAsFigure).onChange(async (value) => {
          settings.openAsFigure = value;
          await this.owner.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Default page preset")
      .setDesc("Page size of a new figure.")
      .addDropdown((dropdown) => {
        for (const preset of PAGE_PRESETS) dropdown.addOption(preset.id, preset.name);
        dropdown.setValue(getPreset(settings.defaultPreset) ? settings.defaultPreset : DEFAULT_SETTINGS.defaultPreset);
        dropdown.onChange(async (value) => {
          settings.defaultPreset = value;
          await this.owner.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Attachment folder")
      .setDesc("Folder for images dropped or pasted into a figure. Leave empty to use Obsidian's attachment setting.")
      .addText((text) =>
        text
          .setPlaceholder("Example: figures/assets")
          .setValue(settings.attachmentFolder)
          .onChange(async (value) => {
            settings.attachmentFolder = value.trim();
            await this.owner.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Export folder")
      .setDesc("Folder for exported files. Leave empty to save them next to the figure.")
      .addText((text) =>
        text
          .setPlaceholder("Example: figures/exports")
          .setValue(settings.exportFolder)
          .onChange(async (value) => {
            settings.exportFolder = value.trim();
            await this.owner.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Export resolution")
      .setDesc(`Dots per inch for raster output, from ${MIN_DPI} to ${MAX_DPI}.`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_DPI);
        text.inputEl.max = String(MAX_DPI);
        text.setValue(String(settings.exportDpi)).onChange(async (value) => {
          const dpi = Number(value);
          // Ignore a half-typed or out-of-range value rather than saving it.
          if (value.trim() === "" || !Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) return;
          settings.exportDpi = Math.round(dpi);
          await this.owner.saveSettings();
        });
      });

    // A note, not a control: where a TIFF source is not shown in the explorer, panels from it still work.
    new Setting(containerEl)
      .setName("TIFF files")
      .setDesc("Obsidian hides `.tif`/`.tiff` files in the file explorer unless Settings → Files and links → Detect all file extensions is on; panels from them work either way.");
  }
}
