import { svgExporter } from "../../src/export/exporters/svg";
import { createDocument, createPage } from "../../src/model/defaults";
import type { ExportInput } from "../../src/registry/exporter";
import { createRegistries } from "../../src/registry";

const input = (over: Partial<ExportInput> = {}): ExportInput => {
  const doc = createDocument("nature-double");
  doc.pages.push(createPage("a4-portrait", [doc.pages[0].id]));
  return {
    doc,
    pages: doc.pages,
    svgs: new Map(doc.pages.map((p) => [p.id, `<svg>${p.name}</svg>`])),
    assets: new Map(),
    registries: createRegistries(),
    warnings: [],
    baseName: "Untitled figure",
    dpi: 300,
    ...over,
  };
};

test("it describes itself as SVG, with no options", () => {
  expect(svgExporter).toMatchObject({ id: "svg", name: "SVG", ext: "svg", mime: "image/svg+xml" });
  expect(svgExporter.options()).toEqual([]);
});

test("one file per page, named after the figure and the page, holding that page's SVG", async () => {
  const { files } = await svgExporter.run(input(), {});
  expect(files.map((f) => f.name)).toEqual(["Untitled figure - Page 1.svg", "Untitled figure - Page 2.svg"]);
  expect(files.map((f) => f.blob.type)).toEqual(["image/svg+xml", "image/svg+xml"]);
  expect(await Promise.all(files.map((f) => f.blob.text()))).toEqual(["<svg>Page 1</svg>", "<svg>Page 2</svg>"]);
});

test("only the pages asked for are exported", async () => {
  const i = input();
  const { files } = await svgExporter.run({ ...i, pages: [i.doc.pages[1]] }, {});
  expect(files.map((f) => f.name)).toEqual(["Untitled figure - Page 2.svg"]);
});

test("the warnings it was given are the warnings it returns", async () => {
  const warnings = ["Node p-aaaa rasterised"];
  expect((await svgExporter.run(input({ warnings }), {})).warnings).toEqual(warnings);
});

test("a page with no built SVG is an error, not an empty file", async () => {
  await expect(svgExporter.run(input({ svgs: new Map() }), {})).rejects.toThrow('No SVG was built for page "Page 1"');
});
