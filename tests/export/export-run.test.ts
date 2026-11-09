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
const { exportFigure, exportInBackground, exportOptions, optionDefaults, DPI_PRESETS, DRAWN_WAIT_MS } = await import("../../src/export/export-run");
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

  test("a warning said for several pages, or said twice by the exporter, is listed once", async () => {
    const { t, doc } = target();
    for (const page of doc.pages) {
      t.doc.nodes.push({ id: `x-${page.id}`, type: "x.chart", page: page.id, x: 0, y: 0, width: 10, height: 10, z: 0, rotation: 0, opacity: 1, locked: false } as never);
    }
    const passthrough: Exporter = {
      id: "pass",
      name: "Pass",
      ext: "txt",
      mime: "text/plain",
      pdfPanels: "raster",
      options: () => [],
      async run(input) {
        return { files: [{ name: "Fig.txt", blob: new Blob(["x"]) }], warnings: [...input.warnings, "twice", "twice"] };
      },
    };
    t.deps.registries.exporters.register(passthrough);
    const out = await exportFigure(t, { format: "pass", pages: "all" });
    expect(out.warnings).toEqual(['"x.chart" item skipped: no plugin draws it', "twice"]);
  });

  test("the figure's unreadable nodes go to the SVG builder and the exporter: skipped with the warning", async () => {
    const { t, doc, spy } = target();
    t.doc.nodes.push({ id: "x-1", type: "x.chart", page: doc.pages[1].id, x: 0, y: 0, width: 10, height: 10, z: 0, rotation: 0, opacity: 1, locked: false } as never);
    const toSvg = vi.fn(() => "<g/>");
    t.deps.registries.nodeTypes.register({ type: "x.chart", name: "Chart", icon: "c", mount: vi.fn(), bounds: vi.fn(), inspector: () => [], toSvg } as never);
    t.unreadable = new Set(["x-1"]);
    await exportFigure(t, { format: "spy" });
    expect(toSvg).not.toHaveBeenCalled();
    expect(spy.runs[0].input.unreadable).toEqual(new Set(["x-1"]));
    expect(spy.runs[0].input.warnings).toEqual(['"x.chart" item skipped: its plugin could not read it']);
  });

  test("a file that would replace a source of the figure is not written, and that is said", async () => {
    const { t } = target();
    t.deps.isProtected = (path) => path === "figs/Fig - Page 2.txt";
    const out = await exportFigure(t, { format: "spy" });
    expect(out.files).toEqual([]);
    expect(out.warnings).toContain("Refused to overwrite figs/Fig - Page 2.txt: it is a source of this figure");
  });
});

describe("exportFigure waits for the figure to be drawn", () => {
  afterEach(() => vi.useRealTimers());

  test("an open figure is exported only once it is drawn; no warning then", async () => {
    let finish: () => void = () => {};
    const { t, spy } = target({ drawn: () => new Promise<void>((resolve) => (finish = resolve)) });
    const out = exportFigure(t, { format: "spy" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(spy.runs).toEqual([]);
    finish();
    expect((await out).warnings).toEqual(["said"]);
    expect(spy.runs).toHaveLength(1);
  });

  test(`the wait is bounded (${DRAWN_WAIT_MS / 1000} s): the export goes on, first in the report that not every item was drawn`, async () => {
    vi.useFakeTimers();
    const { t, spy } = target({ drawn: () => new Promise<void>(() => {}) });
    const out = exportFigure(t, { format: "spy" });
    await vi.advanceTimersByTimeAsync(DRAWN_WAIT_MS - 1);
    expect(spy.runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const done = await out;
    expect(spy.runs).toHaveLength(1);
    expect(done.warnings).toEqual(['"Fig": exported before every item was drawn', "said"]);
    expect(DRAWN_WAIT_MS).toBe(30_000);
  });

  test("a drawing that rejects counts as drawn; the timer is cleared", async () => {
    vi.useFakeTimers();
    const { t } = target({ drawn: () => Promise.reject(new Error("no")) });
    expect((await exportFigure(t, { format: "spy" })).warnings).toEqual(["said"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a bad request is refused before the wait", async () => {
    const drawn = vi.fn(() => new Promise<void>(() => {}));
    const { t } = target({ drawn });
    await expect(exportFigure(t, { format: "gif" })).rejects.toThrow(/no format/);
    await expect(exportFigure(t, { format: "spy", pages: ["nope"] })).rejects.toThrow(/no page/);
    expect(drawn).not.toHaveBeenCalled();
  });
});

describe("exportInBackground", () => {
  /** A host whose figure opens in a "tab" that records being opened, drawn and closed. */
  function background(over: { open?: () => Promise<never> } = {}) {
    const { t, doc, spy } = target();
    const events: string[] = [];
    let finishDrawing: () => void = () => {};
    const host = {
      registries: t.deps.registries,
      settings: t.settings,
      read: vi.fn(async (path: string) => {
        if (path !== t.figurePath) throw new Error(`there is no file "${path}"`);
        return doc;
      }),
      open:
        over.open ??
        vi.fn(async () => {
          events.push("open");
          return {
            target: t,
            drawn: () => {
              events.push("drawing");
              return new Promise<void>((resolve) => (finishDrawing = () => (events.push("drawn"), resolve())));
            },
            close: () => void events.push("close"),
          };
        }),
    };
    return { t, doc, spy, host, events, finishDrawing: () => finishDrawing() };
  }

  test("opens the figure, waits until it is drawn, exports it, and closes it again", async () => {
    const b = background();
    const out = exportInBackground(b.host, b.t.figurePath, { format: "spy", pages: "all" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(b.events).toEqual(["open", "drawing"]);
    expect(b.spy.runs).toEqual([]);
    b.finishDrawing();
    expect((await out).files).toEqual(["figs/Fig - Page 1.txt", "figs/Fig - Page 2.txt", "figs/Fig - Page 3.txt"]);
    expect(b.events).toEqual(["open", "drawing", "drawn", "close"]);
    expect(b.spy.runs).toHaveLength(1);
  });

  test("a background figure that never finishes drawing is exported after the bounded wait, with the warning", async () => {
    vi.useFakeTimers();
    try {
      const b = background();
      const out = exportInBackground(b.host, b.t.figurePath, { format: "spy" });
      await vi.advanceTimersByTimeAsync(DRAWN_WAIT_MS);
      const done = await out;
      expect(done.warnings[0]).toBe('"Fig": exported before every item was drawn');
      expect(b.events).toEqual(["open", "drawing", "close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the tab is closed when the export fails", async () => {
    const b = background();
    b.spy.exporter.run = async () => {
      throw new Error("boom");
    };
    const out = exportInBackground(b.host, b.t.figurePath, { format: "spy" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    b.finishDrawing();
    await expect(out).rejects.toThrow("boom");
    expect(b.events.at(-1)).toBe("close");
  });

  test("it resolves only once the tab is closed (its save on closing done), so a call queued after it cannot race that save", async () => {
    const b = background();
    let closed: () => void = () => {};
    const open = b.host.open as unknown as { (): Promise<Record<string, unknown>>; mockImplementation(fn: () => Promise<unknown>): void };
    const opened = await open();
    open.mockImplementation(async () => ({ ...opened, close: () => new Promise<void>((resolve) => (closed = () => (b.events.push("closed"), resolve()))) }));
    b.events.length = 0;
    let settled = false;
    const out = exportInBackground(b.host, b.t.figurePath, { format: "spy" }).then(() => void (settled = true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    b.finishDrawing();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    closed();
    await out;
    expect(b.events.at(-1)).toBe("closed");
  });

  test("a bad request, or a path that is no figure, is refused without opening a tab", async () => {
    const b = background();
    const refused = async (request: object, path = b.t.figurePath) => exportInBackground(b.host, path, request as never);
    await expect(refused({ format: "gif" })).rejects.toThrow('export: there is no format "gif" (spy)');
    await expect(refused({ format: "spy", dpi: 5000 })).rejects.toThrow("export: the resolution must be a number from 72 to 1200 dpi");
    await expect(refused({ format: "spy", options: { level: 1 } })).rejects.toThrow('unknown option "level"');
    await expect(refused({ format: "spy", pages: "some" })).rejects.toThrow('export: pages must be "current", "all" or a list of page ids');
    await expect(refused({ format: "spy", pages: [] })).rejects.toThrow("export: no pages to export");
    await expect(refused({ format: "spy", pages: ["nope"] })).rejects.toThrow('export: there is no page "nope"');
    await expect(refused({ format: "spy" }, "figs/Other.lnkfig.md")).rejects.toThrow('there is no file "figs/Other.lnkfig.md"');
    expect(b.host.open).not.toHaveBeenCalled();
    expect(b.events).toEqual([]);
    // The format, dpi, options and the form of pages are checked before the file is even read.
    expect(b.host.read).toHaveBeenCalledTimes(3);
  });
});
