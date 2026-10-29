import { nodeLabel } from "../../src/model/labels";
import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { Resolved } from "../../src/links/types";
import { NodeTypeRegistry } from "../../src/registry/node-type";
import type { Exporter } from "../../src/registry/exporter";
import { fakeVault, FakeTFile } from "./fake-vault";

vi.mock("obsidian", async () => {
  const fake = await import("./fake-vault");
  return {
    normalizePath: fake.normalizePath,
    TFile: fake.FakeTFile,
    Modal: class {},
    Notice: class {},
    Setting: class {},
    // The file node type draws with these; here nothing is drawn.
    Component: class {},
    MarkdownRenderer: {},
    setIcon: () => {},
  };
});
vi.mock("../../src/links/decoders/pdf", () => ({ decodePdf: vi.fn(), pdfPageSizePt: vi.fn() }));
const { exportSummary, runExport } = await import("../../src/export/export-modal");
const { isFigureSource } = await import("../../src/export/write");
const { svgExporter } = await import("../../src/export/exporters/svg");
const { fileNodeType } = await import("../../src/nodes/file-node");
const pdfDecoder = await import("../../src/links/decoders/pdf");

// No TIFF or adjusted raster here: the decoders are never asked.
const decoders = { pdf: vi.fn(), tiff: vi.fn(), raster: vi.fn(), adjusts: () => false };
/** Trimming that cuts nothing but records what it was asked to cut. */
const cuts: unknown[] = [];
const pdfTrims: unknown[] = [];
const trim = {
  cutImage: async (dataUri: string, rect: { x: number; y: number; width: number; height: number }) => {
    cuts.push(rect);
    return { dataUri: "data:image/png;base64,CUT", width: rect.width, height: rect.height };
  },
  trimSvg: async (text: string) => ({ text, removed: 0 }),
  trimPdf: async (bytes: ArrayBuffer, pageIndex: number, visible: unknown) => {
    pdfTrims.push({ pageIndex, visible });
    return { bytes: new Uint8Array(bytes), removed: 4, notes: [] };
  },
};

class FakeImage {
  naturalWidth = 640;
  naturalHeight = 480;
  onload: (() => void) | null = null;
  set src(_: string) {
    queueMicrotask(() => this.onload?.());
  }
}
beforeEach(() => vi.stubGlobal("Image", FakeImage));
afterEach(() => vi.unstubAllGlobals());

const nodeTypes = () => {
  const r = new NodeTypeRegistry();
  r.register(fileNodeType);
  return r;
};

/** A figure of two pages: a PNG panel on the first, and on the second a panel whose link is missing. */
function figure() {
  const doc = createDocument("nature-double");
  const second = createPage("a4-portrait", [doc.pages[0].id]);
  doc.pages.push(second);
  const png = { ...fileNodeDefaults(doc.pages[0], { file: "plot.png", subpath: "", show: "image" }, []), x: 0, y: 0, width: 100, height: 50 };
  const gone = { ...fileNodeDefaults(second, { file: "gone.png", subpath: "", show: "image" }, [png.id]), x: 0, y: 0, width: 100, height: 50 };
  doc.nodes.push(png, gone);
  const resolved = new Map<string, Resolved>([
    [png.id, { kind: "image", file: { path: "plot.png", extension: "png" }, src: "app://x", source: "raster", pageCount: 1, deps: ["plot.png"] }],
    [gone.id, { kind: "missing", reason: "file", deps: [] }],
  ]);
  return { doc, png, gone, resolved };
}

function world() {
  const vault = fakeVault();
  const getFileByPath = (path: string) => (path === "plot.png" ? new FakeTFile(path) : null);
  const app = {
    vault: {
      ...vault,
      getFileByPath,
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
      cachedRead: async () => "",
    },
  };
  return { vault, app: app as never };
}

const text = (data: ArrayBuffer | undefined) => new TextDecoder().decode(data);

test("each page gets its own assets and SVG, and the files are written to the folder", async () => {
  const { doc, png, resolved } = figure();
  // All of the 640×480 image shows, so its bytes are embedded as they are, not trimmed.
  png.fit = "contain";
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "exports", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.files).toBe(2);
  expect(vault.calls).toEqual(["createFolder exports", "createBinary exports/Fig - Page 1.svg", "createBinary exports/Fig - Page 2.svg"]);
  const first = text(vault.content.get("exports/Fig - Page 1.svg"));
  expect(first).toContain('href="data:image/png;base64,AQID"');
  expect(first).toContain('width="183mm" height="170mm"');
  const second = text(vault.content.get("exports/Fig - Page 2.svg"));
  expect(second).toContain('width="210mm" height="297mm"');
  expect(second).not.toContain("<image");
});

test("the exporter is given the pages asked for, with their SVGs, their assets, the node types, the dpi and the base name", async () => {
  const { doc, png, resolved } = figure();
  const { app } = world();
  const types = nodeTypes();
  let seen: Parameters<Exporter["run"]>[0] | undefined;
  const spy: Exporter = {
    ...svgExporter,
    async run(input) {
      seen = input;
      return { files: [], warnings: input.warnings };
    },
  };
  await runExport(
    { exporter: spy, doc, pages: [doc.pages[0]], baseName: "Fig", folder: "", dpi: 150, maxPageSizeMm: 2000 },
    { app, nodeTypes: types, resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(seen?.pages).toEqual([doc.pages[0]]);
  expect(seen?.nodeTypes).toBe(types);
  expect([...(seen?.svgs.keys() ?? [])]).toEqual([doc.pages[0].id]);
  expect(seen?.assets.get(doc.pages[0].id)?.get(png.id)?.kind).toBe("image");
  expect(seen).toMatchObject({ baseName: "Fig", dpi: 150, doc });
});

test("what could not be embedded comes back as warnings, from the collection and from the builder alike", async () => {
  const { doc, png, gone, resolved } = figure();
  resolved.set(png.id, { kind: "image", file: { path: "moved.png", extension: "png" }, src: "app://x", source: "raster", pageCount: 1, deps: [] });
  const { app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.files).toBe(2);
  expect(out.warnings).toEqual([
    `${nodeLabel(doc, png)}: File not found in vault: moved.png`,
    `${nodeLabel(doc, png)}: link missing, skipped`,
    `${nodeLabel(doc, gone)}: link missing, skipped`,
  ]);
});

test("an exporter that fails stops the export before anything is written", async () => {
  const { doc, resolved } = figure();
  const { vault, app } = world();
  const failing: Exporter = { ...svgExporter, run: async () => Promise.reject(new Error("no way")) };
  await expect(
    runExport(
      { exporter: failing, doc, pages: doc.pages, baseName: "Fig", folder: "out", dpi: 300, maxPageSizeMm: 2000 },
      { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
    ),
  ).rejects.toThrow("no way");
  expect(vault.calls).toEqual([]);
});

test("a figure with an empty page exports a sheet of paper", async () => {
  const doc = createDocument("a4-portrait");
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Blank", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out).toEqual({ files: 1, warnings: [] });
  expect(text(vault.content.get("Blank - Page 1.svg"))).toContain('<rect width="793.7007874015749" height="1122.5196850393702" fill="#ffffff"/>');
});

/** A figure of pages with the given names, each a different size so that their files can be told apart. */
function namedPages(...names: string[]) {
  const doc = createDocument("nature-double");
  doc.pages[0].name = names[0];
  for (const name of names.slice(1)) doc.pages.push({ ...createPage("a4-portrait", doc.pages.map((p) => p.id), name), width: 100 + doc.pages.length });
  return doc;
}

test("two pages with the same name are written to two files, and the rename is a warning", async () => {
  const doc = namedPages("Page 2", "Page 2");
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.files).toBe(2);
  expect(vault.calls).toEqual(["createBinary Fig - Page 2.svg", "createBinary Fig - Page 2 (2).svg"]);
  expect(text(vault.content.get("Fig - Page 2.svg"))).toContain('width="183mm"');
  expect(text(vault.content.get("Fig - Page 2 (2).svg"))).toContain('width="101mm"');
  expect(out.warnings).toEqual(["Page name 'Fig - Page 2.svg' is used more than once; wrote 'Fig - Page 2 (2).svg'"]);
});

test("names that only become the same once unsafe characters are replaced do not overwrite each other", async () => {
  const doc = namedPages("A/B", "A:B", "A?B");
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "out", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.files).toBe(3);
  expect(vault.calls).toEqual([
    "createFolder out",
    "createBinary out/Fig - A-B.svg",
    "createBinary out/Fig - A-B (2).svg",
    "createBinary out/Fig - A-B (3).svg",
  ]);
  expect(out.warnings).toEqual([
    "Page name 'Fig - A:B.svg' is used more than once; wrote 'Fig - A-B (2).svg'",
    "Page name 'Fig - A?B.svg' is used more than once; wrote 'Fig - A-B (3).svg'",
  ]);
});

test("pages with different names produce no rename warning, and the exporter's own warnings are kept once", async () => {
  const doc = namedPages("One", "Two");
  const { app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.warnings).toEqual([]);
});

describe("an export never writes over a source of the figure", () => {
  /** An exporter that makes one file of each name given. */
  const named = (...names: string[]): Exporter => ({
    ...svgExporter,
    run: async (input) => ({ files: names.map((name) => ({ name, blob: new Blob([name]) })), warnings: input.warnings }),
  });
  const FIGURE = "Figures/Figure 2.lnkfig.md";
  /** What the view hands `runExport`: the figure, notes, and the files its nodes depend on are protected. */
  const guard = (...deps: string[]) => (path: string) => isFigureSource(path, FIGURE, (p) => deps.includes(p));

  test("a file named like a source PDF beside the figure is refused with a warning; the others are written and counted", async () => {
    const doc = createDocument("nature-double");
    const { vault, app } = world();
    vault.entries.set("Figures/Figure 2.pdf", new FakeTFile("Figures/Figure 2.pdf"));
    vault.content.set("Figures/Figure 2.pdf", new TextEncoder().encode("the plot").buffer as ArrayBuffer);
    const out = await runExport(
      { exporter: named("Figure 2.pdf", "Figure 2 - Page 1.svg"), doc, pages: doc.pages, baseName: "Figure 2", folder: "Figures", dpi: 300, maxPageSizeMm: 2000 },
      { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: guard("Figures/Figure 2.pdf") },
    );
    expect(out.files).toBe(1);
    expect(out.warnings).toEqual(["Refused to overwrite Figures/Figure 2.pdf: it is a source of this figure"]);
    expect(vault.calls).toEqual(["createFolder Figures", "createBinary Figures/Figure 2 - Page 1.svg"]);
    expect(text(vault.content.get("Figures/Figure 2.pdf"))).toBe("the plot");
  });

  test("the figure's own file, and any note, are never written", async () => {
    const doc = createDocument("nature-double");
    const { vault, app } = world();
    const out = await runExport(
      { exporter: named("Figure 2.lnkfig.md", "Legend.md"), doc, pages: doc.pages, baseName: "Figure 2", folder: "Figures", dpi: 300, maxPageSizeMm: 2000 },
      { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: guard() },
    );
    expect(out.files).toBe(0);
    expect(out.warnings).toEqual([
      "Refused to overwrite Figures/Figure 2.lnkfig.md: it is a source of this figure",
      "Refused to overwrite Figures/Legend.md: it is a source of this figure",
    ]);
    expect(vault.calls).toEqual([]);
  });

  test("exporting again writes over the previous export, silently", async () => {
    const doc = createDocument("nature-double");
    const { vault, app } = world();
    const run = { exporter: svgExporter, doc, pages: doc.pages, baseName: "Figure 2", folder: "Figures", dpi: 300, maxPageSizeMm: 2000 };
    const deps = { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined, decoders, trim, isProtected: guard("Figures/plot.svg") };
    await runExport(run, deps);
    const again = await runExport(run, deps);
    expect(again).toEqual({ files: 1, warnings: [] });
    expect(vault.calls).toEqual(["createFolder Figures", "createBinary Figures/Figure 2 - Page 1.svg", "modifyBinary Figures/Figure 2 - Page 1.svg"]);
  });
});

test("isFigureSource: the figure file, any note (whatever the case of .md) and a dependency, nothing else", () => {
  const isDependency = (p: string) => p === "Data/plot.pdf";
  expect(isFigureSource("Figures/Fig.lnkfig.md", "Figures/Fig.lnkfig.md", isDependency)).toBe(true);
  expect(isFigureSource("Figures/Notes.MD", "Figures/Fig.lnkfig.md", isDependency)).toBe(true);
  expect(isFigureSource("Data/plot.pdf", "Figures/Fig.lnkfig.md", isDependency)).toBe(true);
  expect(isFigureSource("Figures/Fig.pdf", "Figures/Fig.lnkfig.md", isDependency)).toBe(false);
});

test("the success message names the folder, or the vault root", () => {
  expect(exportSummary(2, "Figures/out")).toBe("Exported 2 file(s) to Figures/out");
  expect(exportSummary(1, "")).toBe("Exported 1 file(s) to the vault root");
  expect(exportSummary(1, "/")).toBe("Exported 1 file(s) to the vault root");
});

test("a page over the page limit is still exported, with a warning", async () => {
  const { doc, resolved } = figure();
  doc.pages[0].width = 3000;
  doc.pages[0].height = 210;
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: [doc.pages[0]], baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.files).toBe(1);
  expect(vault.content.has("Fig - Page 1.svg")).toBe(true);
  expect(out.warnings).toContain('Page "Page 1" is 3000 × 210 mm, over the 2000 mm page limit');
});

test("each cropped panel is trimmed after collection and before the page is built, and the report is in the warnings", async () => {
  const { doc, png, resolved } = figure();
  png.fit = "contain";
  png.crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const moved = { ...png, id: "moved", file: "moved.png", crop: null };
  doc.nodes.push(moved);
  resolved.set(moved.id, { kind: "image", file: { path: "moved.png", extension: "png" }, src: "app://x", source: "raster", pageCount: 1, deps: [] });
  const { vault, app } = world();
  cuts.length = 0;
  const out = await runExport(
    { exporter: svgExporter, doc, pages: [doc.pages[0]], baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  // The fake image is 640×480.
  expect(cuts).toEqual([{ x: 160, y: 120, width: 320, height: 240 }]);
  expect(text(vault.content.get("Fig - Page 1.svg"))).toContain('href="data:image/png;base64,CUT"');
  expect(out.warnings).toEqual([
    `${nodeLabel(doc, moved)}: File not found in vault: moved.png`,
    `${nodeLabel(doc, moved)}: link missing, skipped`,
    `${nodeLabel(doc, png)}: cut to what shows (320 × 240 of 640 × 480 px)`,
  ]);
});

test("the report puts panels that could not be trimmed first, then the warnings, then the rest of the trim report", async () => {
  const { doc, png, gone, resolved } = figure();
  png.fit = "contain";
  png.crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const bad = { ...png, id: "bad", x: 200 };
  doc.nodes.push(bad);
  resolved.set(bad.id, resolved.get(png.id)!);
  const { app } = world();
  let calls = 0;
  const failing = {
    ...trim,
    cutImage: async (dataUri: string, rect: { x: number; y: number; width: number; height: number }) => {
      if (++calls === 2) throw new Error("out of memory");
      return trim.cutImage(dataUri, rect);
    },
  };
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim: failing, isProtected: () => false },
  );
  expect(out.warnings).toEqual([
    `${nodeLabel(doc, bad)}: could not be trimmed, embedded whole (out of memory)`,
    `${nodeLabel(doc, gone)}: link missing, skipped`,
    `${nodeLabel(doc, png)}: cut to what shows (320 × 240 of 640 × 480 px)`,
  ]);
});

test.each([
  ["raster", "cut to what shows (626 × 313 of 1250 × 625 px)", 1, 0],
  ["vector", "4 items outside the crop removed", 0, 1],
] as const)("a cropped PDF panel is trimmed as the %s exporter embeds it, and only that is reported", async (pdfPanels, line, cutCount, pdfCount) => {
  const { doc, png, resolved } = figure();
  Object.assign(png, { file: "plot.pdf", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  resolved.set(png.id, { kind: "image", file: { path: "plot.pdf", extension: "pdf" }, src: "app://x", source: "pdf", pageCount: 1, deps: [] });
  vi.mocked(pdfDecoder.decodePdf).mockResolvedValue({ dataUrl: "data:image/png;base64,PAGE", width: 1250, height: 625, pageCount: 1 });
  vi.mocked(pdfDecoder.pdfPageSizePt).mockResolvedValue({ width: 300, height: 150 });
  const { app } = world();
  (app as { vault: { getFileByPath: (path: string) => unknown } }).vault.getFileByPath = (path) => new FakeTFile(path);
  const spy: Exporter = { ...svgExporter, pdfPanels, run: async (input) => ({ files: [], warnings: input.warnings }) };
  cuts.length = 0;
  pdfTrims.length = 0;
  const out = await runExport(
    { exporter: spy, doc, pages: [doc.pages[0]], baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(cuts).toHaveLength(cutCount);
  expect(pdfTrims).toHaveLength(pdfCount);
  expect(out.warnings.filter((w) => !/PDF panel rasterised/.test(w))).toEqual([`${nodeLabel(doc, png)}: ${line}`]);
});

test("a panel over the decode limit is reported with that reason, once, and not as a missing link", async () => {
  const { doc, png, gone, resolved } = figure();
  resolved.set(png.id, { kind: "missing", reason: "decode", deps: [], message: "over the 50 MP limit" });
  resolved.set(gone.id, { kind: "missing", reason: "subpath", deps: [] });
  const { app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300, maxPageSizeMm: 2000 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined, decoders, trim, isProtected: () => false },
  );
  expect(out.warnings).toEqual([
    `${nodeLabel(doc, png)}: could not be decoded (over the 50 MP limit), skipped`,
    `${nodeLabel(doc, gone)}: heading or block not found, skipped`,
  ]);
});
