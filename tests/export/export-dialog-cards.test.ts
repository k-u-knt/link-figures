import { createDocument } from "../../src/model/defaults";
import { createRegistries } from "../../src/registry";
import type { Exporter } from "../../src/registry/exporter";

/** Settings that record their name and their toggle, so the dialog's options can be read and switched. */
const settings = vi.hoisted(() => [] as { name: string; toggle?: { value: boolean; change: (on: boolean) => void } }[]);
vi.mock("obsidian", () => {
  const el = (): unknown => ({ empty: () => {}, createEl: () => el(), createDiv: () => el(), createSpan: () => el(), addEventListener: () => {}, focus: () => {}, querySelector: () => null });
  class Setting {
    entry: (typeof settings)[number] = { name: "" };
    controlEl = el();
    constructor() {
      settings.push(this.entry);
    }
    setName(name: string) {
      this.entry.name = name;
      return this;
    }
    setDesc() {
      return this;
    }
    addToggle(cb: (t: unknown) => void) {
      const toggle = {
        value: false,
        change: (_: boolean) => {},
        setValue(v: boolean) {
          toggle.value = v;
          return toggle;
        },
        onChange(f: (on: boolean) => void) {
          toggle.change = f;
          return toggle;
        },
      };
      this.entry.toggle = toggle;
      cb(toggle);
      return this;
    }
    addDropdown(cb: (d: unknown) => void) {
      const d = { addOption: () => d, setValue: () => d, onChange: () => d };
      cb(d);
      return this;
    }
    addText(cb: (t: unknown) => void) {
      const t = { inputEl: {}, setValue: () => t, onChange: () => t };
      cb(t);
      return this;
    }
    addButton() {
      return this;
    }
  }
  class Modal {
    contentEl = el();
    modalEl = el();
    constructor(public app: unknown) {}
    setTitle() {
      return this;
    }
    open() {
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close() {
      (this as unknown as { onClose(): void }).onClose();
    }
  }
  return { Modal, Notice: class {}, Setting };
});
const { ExportModal } = await import("../../src/export/export-modal");
const { createPptxExporter } = await import("../../src/export/exporters/pptx");

test('the dialog has "Export cards as Markdown" for every format and "Card text in presenter notes" for PowerPoint, both off', () => {
  const registries = createRegistries();
  const svg: Exporter = { id: "svg", name: "SVG", ext: "svg", mime: "image/svg+xml", pdfPanels: "vector", options: () => [], run: async () => ({ files: [], warnings: [] }) };
  registries.exporters.register(svg);
  registries.exporters.register(createPptxExporter({ renderClearPng: async () => new Uint8Array() }));
  const doc = createDocument("a4-portrait");
  const view = { app: {}, store: { doc }, focusPage: () => doc.pages[0], plugin: { registries, settings: { exportDpi: 300 } } } as never;
  const modal = ExportModal.show(view);
  try {
    const toggles = () => settings.filter((s) => s.toggle).map((s) => [s.name, s.toggle!.value]);
    expect(toggles()).toEqual([["Export cards as Markdown", false]]);
    const internals = modal as unknown as { formatId: string; renderOptions(): void; optionValues: Record<string, unknown> };
    settings.length = 0;
    internals.formatId = "pptx";
    internals.renderOptions();
    expect(toggles()).toEqual([
      ["Card text in presenter notes", false],
      ["Export cards as Markdown", false],
    ]);
    for (const s of settings) s.toggle?.change(true);
    expect(internals.optionValues).toEqual({ notes: true, cards: "markdown" });
    settings.find((s) => s.name === "Export cards as Markdown")!.toggle!.change(false);
    expect(internals.optionValues.cards).toBeNull();
  } finally {
    modal.close();
  }
});
