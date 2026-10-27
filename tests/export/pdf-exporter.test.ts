import { pdfExporter } from "../../src/export/exporters/pdf";
import { createDocument, createPage } from "../../src/model/defaults";
import type { ExportInput } from "../../src/registry/exporter";

// jsPDF and svg2pdf.js are replaced by a recorder: what is checked here is what the exporter asks of them, per page.
// (Whether the PDF they make is right can only be seen in a real browser.)
const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor(options: unknown) {
      calls.push(["new", options]);
    }
    addPage(...args: unknown[]) {
      calls.push(["addPage", ...args]);
    }
    async svg(element: { source: string }, options: unknown) {
      calls.push(["svg", element.source, options]);
    }
    output(type: string) {
      calls.push(["output", type]);
      return new Blob(["%PDF"], { type: "application/pdf" });
    }
  },
}));
vi.mock("svg2pdf.js", () => ({}));

// There is no DOM in this suite; a document that is not an <svg> stands for what the browser returns as <parsererror>.
class FakeDOMParser {
  parseFromString(source: string) {
    const bad = !source.startsWith("<svg");
    return {
      documentElement: { source },
      getElementsByTagName: () => (bad ? [{ textContent: "error on line 1", querySelector: () => null }] : []),
    };
  }
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("DOMParser", FakeDOMParser);
});
afterEach(() => vi.unstubAllGlobals());

const input = (over: Partial<ExportInput> = {}): ExportInput => {
  const doc = createDocument("nature-double");
  doc.pages.push(createPage("a4-portrait", [doc.pages[0].id]));
  return {
    doc,
    pages: doc.pages,
    svgs: new Map(doc.pages.map((p) => [p.id, `<svg>${p.name}</svg>`])),
    assets: new Map(),
    warnings: [],
    baseName: "Untitled figure",
    dpi: 300,
    ...over,
  };
};

test("it describes itself as a vector PDF, with no options", () => {
  expect(pdfExporter).toMatchObject({ id: "pdf", name: "PDF (vector)", ext: "pdf", mime: "application/pdf" });
  expect(pdfExporter.options()).toEqual([]);
});

test("one PDF: the first page sets the document up, later pages are added, each is drawn at its own size", async () => {
  const { files } = await pdfExporter.run(input(), {});
  expect(calls).toEqual([
    ["new", { unit: "mm", format: [183, 170], orientation: "landscape", compress: true }],
    ["svg", "<svg>Page 1</svg>", { x: 0, y: 0, width: 183, height: 170 }],
    ["addPage", [210, 297], "portrait"],
    ["svg", "<svg>Page 2</svg>", { x: 0, y: 0, width: 210, height: 297 }],
    ["output", "blob"],
  ]);
  expect(files.map((f) => f.name)).toEqual(["Untitled figure.pdf"]);
  expect(files[0].blob.type).toBe("application/pdf");
});

test("the warnings it was given are the warnings it returns", async () => {
  const warnings = ["Node p-aaaa rasterised"];
  expect((await pdfExporter.run(input({ warnings }), {})).warnings).toEqual(warnings);
});

test("no pages make no file, not a blank PDF", async () => {
  expect((await pdfExporter.run(input({ pages: [] }), {})).files).toEqual([]);
  expect(calls).toEqual([]);
});

test("a page with no built SVG is an error, before any drawing", async () => {
  await expect(pdfExporter.run(input({ svgs: new Map() }), {})).rejects.toThrow('No SVG was built for page "Page 1"');
  expect(calls).toEqual([]);
});

test("an SVG the parser rejects is an error that names the page", async () => {
  const i = input();
  const svgs = new Map(i.svgs).set(i.doc.pages[1].id, "not xml");
  await expect(pdfExporter.run({ ...i, svgs }, {})).rejects.toThrow('The SVG built for page "Page 2" is not valid XML: error on line 1');
});
