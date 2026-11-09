import { createDocument } from "../../src/model/defaults";
import { createRegistries } from "../../src/registry";

/** A Modal that opens and closes as Obsidian's does, as far as the export dialog uses it (no format: a line of text). */
vi.mock("obsidian", () => {
  const el = () => {
    const node = { focused: 0, children: [] as unknown[], empty: () => void (node.children = []), createEl: () => el(), focus: () => void node.focused++, querySelector: () => null };
    return node;
  };
  class Modal {
    contentEl = el();
    modalEl = el();
    isOpen = false;
    constructor(public app: unknown) {}
    setTitle() {
      return this;
    }
    open() {
      this.isOpen = true;
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close() {
      this.isOpen = false;
      (this as unknown as { onClose(): void }).onClose();
    }
  }
  return { Modal, Notice: class {}, Setting: class {} };
});
const { ExportModal } = await import("../../src/export/export-modal");

function view() {
  const doc = createDocument("a4-portrait");
  return { app: {}, store: { doc }, focusPage: () => doc.pages[0], plugin: { registries: createRegistries(), settings: { exportDpi: 300 } } } as never;
}

afterEach(() => ExportModal.openDialog()?.close());

test("the Export command opens one dialog; asked again while it is open, it focuses that one instead of stacking a second", () => {
  const v = view();
  const first = ExportModal.show(v);
  expect((first as unknown as { isOpen: boolean }).isOpen).toBe(true);
  const focused = (first.modalEl as unknown as { focused: number }).focused;
  const again = ExportModal.show(v);
  expect(again).toBe(first);
  expect((first.modalEl as unknown as { focused: number }).focused).toBe(focused + 1);
  // From another figure too: the open dialog is kept.
  expect(ExportModal.show(view())).toBe(first);
});

test("once the dialog is closed, the command opens a new one", () => {
  const first = ExportModal.show(view());
  first.close();
  expect(ExportModal.openDialog()).toBeNull();
  const second = ExportModal.show(view());
  expect(second).not.toBe(first);
  expect((second as unknown as { isOpen: boolean }).isOpen).toBe(true);
});
