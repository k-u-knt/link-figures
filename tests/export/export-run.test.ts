import { createDocument, createPage } from "../../src/model/defaults";
import type { Document } from "../../src/model/types";
import { createRegistries } from "../../src/registry";
import type { Exporter, ExportInput } from "../../src/registry/exporter";
import type { Field } from "../../src/registry/fields";
import { fakeVault } from "./fake-vault";

vi.mock("obsidian", async () => {
  const fake = await import("./fake-vault");
  return { normalizePath: fake.normalizePath, TFile: fake.FakeTFile, Modal: class {}, Notice: class {}, Setting: class {} };
});
vi.mock("../../src/links/decoders/pdf", () => ({ decodePdf: vi.fn(), pdfPageSizePt: vi.fn() }));
const { exportFigure, exportOptions, optionDefaults, DPI_PRESETS } = await import("../../src/export/export-run");
type FigureExportTarget = import("../../src/export/export-run").FigureExportTarget;

const FIELDS: Field[] = [
  { kind: "select", key: "compression", label: "Compression", options: [{ value: "deflate", label: "Deflate" }, { value: "none", label: "None" }] },
  { kind: "toggle", key: "alpha", label: "Alpha" },
  { kind: "number", key: "quality", label: "Quality", min: 1, max: 100 },
  { kind: "text", key: "title", label: "Title" },
  { kind: "heading", key: "h", label: "More" },
];

/** An exporter that records what it was run with and writes one file per page. */
function spyExporter(fields: Field[] = FIELDS) {
  const runs: { input: ExportInput; opts: Record<string, unknown> }[] = [];
  const exporter: Exporter = {
    id: "spy",
    name: "Spy",
    ext: "txt",
    mime: "text/plain",
    pdfPanels: "raster",
    options: () => fields,
    async run(input, opts) {
      runs.push({ input, opts });
      return { files: input.pages.map((p) => ({ name: `${input.baseName} - ${p.name}.txt`, blob: new Blob([p.name]) })), warnings: ["said"] };
    },
  };
  return { exporter, runs };
}

function target(over: Partial<FigureExportTarget> = {}) {
  const doc: Document = createDocument("nature-double");
  doc.pages.push(createPage("a4-portrait", [doc.pages[0].id]));
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  const registries = createRegistries();
  const spy = spyExporter();
  registries.exporters.register(spy.exporter);
  const vault = fakeVault();
  const t: FigureExportTarget = {
    figurePath: "figs/Fig.lnkfig.md",
    baseName: "Fig",
    doc,
    currentPage: doc.pages[1],
    settings: { exportFolder: "", exportDpi: 300, maxPageSizeMm: 2000 },
    deps: {
      app: { vault } as never,
      registries,
      resolved: () => undefined,
      elementFor: () => undefined,
      decoders: {} as never,
      trim: {} as never,
      isProtected: () => false,
    },
    ...over,
  };
  return { t, doc, spy, vault };
}

describe("exporter options", () => {
  test("each option's default: a select's first choice, a toggle off, a number's minimum, empty text; headings have none", () => {
    expect(optionDefaults(FIELDS)).toEqual({ compression: "deflate", alpha: false, quality: 1, title: "" });
  });

  test("given values replace the defaults", () => {
    const { exporter } = spyExporter();
    expect(exportOptions(exporter, { compression: "none", quality: 80 })).toEqual({ compression: "none", alpha: false, quality: 80, title: "" });
  });

  test("an unknown option, or a value the field does not take, is refused with the option named", () => {
    const { exporter } = spyExporter();
    expect(() => exportOptions(exporter, { level: 2 })).toThrow('spy: unknown option "level"');
    expect(() => exportOptions(exporter, { compression: "lzw" })).toThrow('spy: option "compression" must be one of deflate, none');
    expect(() => exportOptions(exporter, { alpha: "yes" })).toThrow('spy: option "alpha" must be true or false');
    expect(() => exportOptions(exporter, { quality: 101 })).toThrow('spy: option "quality" must be a number from 1 to 100');
    expect(() => exportOptions(exporter, { title: 3 })).toThrow('spy: option "title" must be text');
    expect(() => exportOptions(exporter, [] as never)).toThrow("spy: options must be an object");
  });

  test("the dpi presets are the journal resolutions", () => {
    expect(DPI_PRESETS).toEqual([300, 600, 1000]);
  });
});

describe("exportFigure", () => {
  test("the current page, at the settings' dpi, with the exporter's default options; the written paths are given", async () => {
    const { t, doc, spy } = target();
    const out = await exportFigure(t, { format: "spy" });
    expect(spy.runs).toHaveLength(1);
    expect(spy.runs[0].input.pages).toEqual([doc.pages[1]]);
    expect(spy.runs[0].input.dpi).toBe(300);
    expect(spy.runs[0].opts).toEqual({ compression: "deflate", alpha: false, quality: 1, title: "" });
    expect(out).toEqual({ files: ["figs/Fig - Page 2.txt"], warnings: ["said"], folder: "figs" });
  });

  test("all pages, or the pages named, at the dpi asked for (rounded), with the options given", async () => {
    const { t, doc, spy } = target({ settings: { exportFolder: "out", exportDpi: 300, maxPageSizeMm: 2000 } });
    const all = await exportFigure(t, { format: "spy", pages: "all", dpi: 600.4, options: { compression: "none" } });
    expect(spy.runs[0].input.pages).toEqual(doc.pages);
    expect(spy.runs[0].input.dpi).toBe(600);
    expect(spy.runs[0].opts.compression).toBe("none");
    expect(all.files).toEqual(["out/Fig - Page 1.txt", "out/Fig - Page 2.txt", "out/Fig - Page 3.txt"]);
    await exportFigure(t, { format: "spy", pages: [doc.pages[2].id, doc.pages[0].id, doc.pages[2].id] });
    expect(spy.runs[1].input.pages).toEqual([doc.pages[2], doc.pages[0]]);
  });

  test("bad requests are refused before anything is exported", async () => {
    const { t, spy } = target();
    await expect(exportFigure(t, { format: "gif" })).rejects.toThrow('export: there is no format "gif" (spy)');
    await expect(exportFigure(t, { format: "spy", dpi: 50 })).rejects.toThrow("export: the resolution must be a number from 72 to 1200 dpi");
    await expect(exportFigure(t, { format: "spy", dpi: Number.NaN })).rejects.toThrow(/resolution/);
    await expect(exportFigure(t, { format: "spy", pages: ["nope"] })).rejects.toThrow('export: there is no page "nope"');
    await expect(exportFigure(t, { format: "spy", pages: [] })).rejects.toThrow("export: no pages to export");
    await expect(exportFigure(t, { format: "spy", pages: "some" as never })).rejects.toThrow('export: pages must be "current", "all" or a list of page ids');
    await expect(exportFigure(t, { format: "spy", options: { level: 1 } })).rejects.toThrow('unknown option "level"');
    expect(spy.runs).toEqual([]);
  });

  test("a file that would replace a source of the figure is not written, and that is said", async () => {
    const { t } = target();
    t.deps.isProtected = (path) => path === "figs/Fig - Page 2.txt";
    const out = await exportFigure(t, { format: "spy" });
    expect(out.files).toEqual([]);
    expect(out.warnings).toContain("Refused to overwrite figs/Fig - Page 2.txt: it is a source of this figure");
  });
});
