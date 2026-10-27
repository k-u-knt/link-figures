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
vi.mock("../../src/links/decoders/tiff", () => ({ decodeTiff: vi.fn() }));
const { runExport } = await import("../../src/export/export-modal");
const { svgExporter } = await import("../../src/export/exporters/svg");
const { fileNodeType } = await import("../../src/nodes/file-node");

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
  const { doc, resolved } = figure();
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "exports", dpi: 300 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined },
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
    { exporter: spy, doc, pages: [doc.pages[0]], baseName: "Fig", folder: "", dpi: 150 },
    { app, nodeTypes: types, resolved: (id) => resolved.get(id), elementFor: () => undefined },
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
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300 },
    { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined },
  );
  expect(out.files).toBe(2);
  expect(out.warnings).toEqual([
    `Node ${png.id}: File not found in vault: moved.png`,
    `Node ${png.id}: link missing, skipped`,
    `Node ${gone.id}: link missing, skipped`,
  ]);
});

test("an exporter that fails stops the export before anything is written", async () => {
  const { doc, resolved } = figure();
  const { vault, app } = world();
  const failing: Exporter = { ...svgExporter, run: async () => Promise.reject(new Error("no way")) };
  await expect(
    runExport(
      { exporter: failing, doc, pages: doc.pages, baseName: "Fig", folder: "out", dpi: 300 },
      { app, nodeTypes: nodeTypes(), resolved: (id) => resolved.get(id), elementFor: () => undefined },
    ),
  ).rejects.toThrow("no way");
  expect(vault.calls).toEqual([]);
});

test("a figure with an empty page exports a sheet of paper", async () => {
  const doc = createDocument("a4-portrait");
  const { vault, app } = world();
  const out = await runExport(
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Blank", folder: "", dpi: 300 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined },
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
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined },
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
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "out", dpi: 300 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined },
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
    { exporter: svgExporter, doc, pages: doc.pages, baseName: "Fig", folder: "", dpi: 300 },
    { app, nodeTypes: nodeTypes(), resolved: () => undefined, elementFor: () => undefined },
  );
  expect(out.warnings).toEqual([]);
});
