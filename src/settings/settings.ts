import { PluginSettingTab, Setting, type App } from "obsidian";
import { DEFAULT_PAGE_LIMIT_MM, MAX_DPI, MAX_PAGE_LIMIT_MM, MIN_DPI, MIN_PAGE_LIMIT_MM, normalisePageLimit } from "../constants";
import type LinkFiguresPlugin from "../main";
import { blockIdPrefix } from "../links/block-id";
import { PAGE_PRESETS, getPreset } from "../model/presets";

/**
 * What a drop from a note's editor links to: the block, by its id (`"block-id"`, written into the note when it has
 * none); the block's id when it has one, else the nearest heading above it, writing nothing (`"heading"`); or, as before
 * this setting, the dropped links themselves and an image's own file (`"direct"`).
 */
export type DropFromNote = "block-id" | "heading" | "direct";

export const DROP_FROM_NOTE_MODES: readonly DropFromNote[] = ["block-id", "heading", "direct"];

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
  /** The largest width or height, in mm, that the inspector lets a page have. */
  maxPageSizeMm: number;
  dropFromNote: DropFromNote;
  /** The first part of a block id written into a note: `<prefix>-<4 base36>`. Letters, digits and dashes. */
  blockIdPrefix: string;
}

export const DEFAULT_SETTINGS: LinkFiguresSettings = {
  attachmentFolder: "",
  openAsFigure: true,
  defaultPreset: "nature-double",
  exportFolder: "",
  exportDpi: 300,
  maxPageSizeMm: DEFAULT_PAGE_LIMIT_MM,
  dropFromNote: "block-id",
  blockIdPrefix: "fig",
};

/** The settings as saved (`loadData`, possibly from an older version, possibly null) with defaults for what is missing and every value made one it can take. */
export function normaliseSettings(saved: unknown): LinkFiguresSettings {
  const settings: LinkFiguresSettings = Object.assign({}, DEFAULT_SETTINGS, saved);
  settings.maxPageSizeMm = normalisePageLimit(settings.maxPageSizeMm);
  if (!DROP_FROM_NOTE_MODES.includes(settings.dropFromNote)) settings.dropFromNote = DEFAULT_SETTINGS.dropFromNote;
  settings.blockIdPrefix = blockIdPrefix(typeof settings.blockIdPrefix === "string" ? settings.blockIdPrefix : "");
  return settings;
}

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

    new Setting(containerEl)
      .setName("Maximum page size (mm)")
      .setDesc(`Pages larger than this cannot be made, to keep the editor and exports within memory. ${MIN_PAGE_LIMIT_MM}–${MAX_PAGE_LIMIT_MM} mm.`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_PAGE_LIMIT_MM);
        text.inputEl.max = String(MAX_PAGE_LIMIT_MM);
        text.setValue(String(settings.maxPageSizeMm)).onChange(async (value) => {
          const mm = Number(value);
          // Ignore a half-typed value; a number outside the range is brought into it.
          if (value.trim() === "" || !Number.isFinite(mm)) return;
          settings.maxPageSizeMm = normalisePageLimit(mm);
          await this.owner.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Drop from a note")
      .setDesc(
        "What a panel dragged out of a note's editor links to. Block: the paragraph, list item, table or image's block, by its block id, which is added to the note when it has none. Heading: the block's id when it has one, else the nearest heading above it; the note is never changed. Direct: the links in the dragged text, and an image's own file.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("block-id", "Block (adds a block id)");
        dropdown.addOption("heading", "Heading");
        dropdown.addOption("direct", "Direct");
        dropdown.setValue(settings.dropFromNote);
        dropdown.onChange(async (value) => {
          settings.dropFromNote = DROP_FROM_NOTE_MODES.includes(value as DropFromNote) ? (value as DropFromNote) : DEFAULT_SETTINGS.dropFromNote;
          await this.owner.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Block id prefix")
      .setDesc("New block ids are this prefix, a dash and four letters or digits, such as fig-3k9x. Letters, digits and dashes only.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.blockIdPrefix)
          .setValue(settings.blockIdPrefix)
          .onChange(async (value) => {
            // What an id cannot hold is left out, and the field shows what is kept; an empty field (the placeholder) is the default.
            settings.blockIdPrefix = blockIdPrefix(value);
            if (value !== "" && value !== settings.blockIdPrefix) text.setValue(settings.blockIdPrefix);
            await this.owner.saveSettings();
          }),
      );

    // A note, not a control: where a TIFF source is not shown in the explorer, panels from it still work.
    new Setting(containerEl)
      .setName("TIFF files")
      .setDesc("Obsidian hides `.tif`/`.tiff` files in the file explorer unless Settings → Files and links → Detect all file extensions is on; panels from them work either way.");
  }
}
