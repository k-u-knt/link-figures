import { PDF_SCREEN_DPI } from "../../src/constants";
import { isPanelExtension, resolveFileNode, sourceKindOf } from "../../src/links/resolver";
import type { DecodedImage } from "../../src/links/types";
import { createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { FakeAccess } from "./fake-access";

const access = new FakeAccess({ files: { "Notes/analysis.md": "# A\n\n## Results\ntext\n\n![[plot.png]] ^fig2b\n\n## Figure 2 legend\n**Figure 2.** Counts.\n", "Notes/plot.png": "BINARY", "Notes/plot.svg": "<svg/>", "Notes/plot.pdf": "BINARY", "Notes/cells.tif": "BINARY" }, headings: { "Notes/analysis.md": { "Results": { start: 5, end: 40 }, "Figure 2 legend": { start: 40, end: null } } }, blocks: { "Notes/analysis.md": { "fig2b": { start: 22, end: 38 } } }, embeds: { "Notes/analysis.md": [{ link: "plot.png", offset: 22 }] } });
const decoders = { pdf: vi.fn(async (_bytes: ArrayBuffer, _pageIndex: number, _scale: number) => ({ dataUrl: "data:pdf", width: 300, height: 200, pageCount: 3 })), tiff: vi.fn(async (..._args: unknown[]) => ({ dataUrl: "data:tif", width: 256, height: 256, pageCount: 3 })) };
const node = (over: Partial<FileNode>): FileNode => ({ ...fileNodeDefaults(createPage("a4-portrait", []), { file: "", subpath: "", show: "image" }, []), ...over });

beforeEach(() => { vi.clearAllMocks(); });

test("direct image link", async () => { const r = await resolveFileNode(node({ file: "plot.png" }), "Figs/f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "image", source: "raster", src: "app://Notes/plot.png", pageCount: 1, deps: ["Notes/plot.png"] }); });
test("image through a note block", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#^fig2b" }), "f.lnkfig.md", access, decoders); expect(r.kind).toBe("image"); expect(r.deps).toEqual(["Notes/analysis.md", "Notes/plot.png"]); });
test("content of a heading section", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#Figure 2 legend", show: "content" }), "f.lnkfig.md", access, decoders); expect(r.kind).toBe("content"); expect((r as any).markdown).toContain("**Figure 2.**"); });
test("svg source is native", async () => { const r = await resolveFileNode(node({ file: "plot.svg" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "image", source: "svg", src: "app://Notes/plot.svg" }); });
test("pdf source is decoded at the node's page and screen dpi", async () => { const r = await resolveFileNode(node({ file: "plot.pdf", pageIndex: 2 }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "image", source: "pdf", src: "data:pdf", pageCount: 3, deps: ["Notes/plot.pdf"] }); expect(decoders.pdf).toHaveBeenCalledWith(expect.any(ArrayBuffer), 2, PDF_SCREEN_DPI / 72); });
test("tiff source is decoded with the node's range", async () => { const r = await resolveFileNode(node({ file: "cells.tif", range: { min: 100, max: 4000 } }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "image", source: "tiff", src: "data:tif" }); expect(decoders.tiff).toHaveBeenCalledWith(expect.any(ArrayBuffer), 0, { min: 100, max: 4000 }); });
test("decoder failure is missing:decode", async () => { const bad = { ...decoders, pdf: vi.fn(async (): Promise<DecodedImage> => { throw new Error("corrupt"); }) }; const r = await resolveFileNode(node({ file: "plot.pdf" }), "f.lnkfig.md", access, bad); expect(r).toMatchObject({ kind: "missing", reason: "decode", deps: ["Notes/plot.pdf"] }); });
test("missing file", async () => { const r = await resolveFileNode(node({ file: "nope.png" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "missing", reason: "file" }); });
test("missing subpath", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#Gone" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "missing", reason: "subpath", deps: ["Notes/analysis.md"] }); });
test("section without an image", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#Figure 2 legend" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "missing", reason: "no-image" }); });
test("empty file is missing", async () => { expect((await resolveFileNode(node({}), "f.lnkfig.md", access, decoders)).kind).toBe("missing"); });

// Beyond the brief.

const extra = new FakeAccess({
  files: {
    "Notes/analysis.md": "![[first.png|300]] ![[other-note]] ![[gone.png]] ![[second.png#page=2]]\nNo more.\n",
    "Notes/other-note.md": "# Other\n",
    "Notes/first.png": "BINARY",
    "Notes/second.png": "BINARY",
    "Notes/Plot.PNG": "BINARY",
    "Notes/Scan.TIFF": "BINARY",
    "Notes/Paper.PDF": "BINARY",
    "Notes/data.csv": "a,b\n1,2\n",
  },
  headings: { "Notes/analysis.md": { "Sec": { start: 0, end: null } } },
  blocks: { "Notes/analysis.md": { "all": { start: 0, end: null } } },
  embeds: { "Notes/analysis.md": [{ link: "first.png|300", offset: 0 }, { link: "other-note", offset: 19 }, { link: "gone.png", offset: 36 }, { link: "second.png#page=2", offset: 53 }] },
});

test("an alias or size suffix on a direct link is ignored", async () => { const r = await resolveFileNode(node({ file: "plot.png|300" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "image", src: "app://Notes/plot.png", deps: ["Notes/plot.png"] }); });
test("an alias after a subpath is ignored", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#^fig2b|label" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "image", src: "app://Notes/plot.png", deps: ["Notes/analysis.md", "Notes/plot.png"] }); });
test("an alias after a heading is ignored for content", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#Figure 2 legend|label", show: "content" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "content", deps: ["Notes/analysis.md"] }); expect((r as any).markdown).toContain("**Figure 2.**"); });
test("a link that is only an alias is missing:file", async () => { expect(await resolveFileNode(node({ file: "|300" }), "f.lnkfig.md", access, decoders)).toMatchObject({ kind: "missing", reason: "file", deps: [] }); });
test("extensions are matched case-insensitively", async () => {
  expect(await resolveFileNode(node({ file: "Plot.PNG" }), "f.lnkfig.md", extra, decoders)).toMatchObject({ kind: "image", source: "raster", src: "app://Notes/Plot.PNG" });
  expect(await resolveFileNode(node({ file: "Scan.TIFF" }), "f.lnkfig.md", extra, decoders)).toMatchObject({ kind: "image", source: "tiff", src: "data:tif" });
  expect(await resolveFileNode(node({ file: "Paper.PDF" }), "f.lnkfig.md", extra, decoders)).toMatchObject({ kind: "image", source: "pdf", src: "data:pdf" });
});
test("isPanelExtension accepts the panel extensions in any case", () => {
  for (const ext of ["png", "JPG", "jpeg", "gif", "webp", "bmp", "avif", "svg", "pdf", "tif", "TIFF"]) expect(isPanelExtension(ext)).toBe(true);
  for (const ext of ["md", "csv", "canvas", ""]) expect(isPanelExtension(ext)).toBe(false);
});
test.each([["svg", "svg"], ["SVG", "svg"], ["pdf", "pdf"], ["tif", "tiff"], ["TIFF", "tiff"], ["png", "raster"], ["webp", "raster"]])("sourceKindOf(%s) is %s", (ext, kind) => { expect(sourceKindOf(ext)).toBe(kind); });
test("imageIndex counts only embeds that resolve to a panel file, in document order", async () => {
  const first = await resolveFileNode(node({ file: "analysis", subpath: "#^all", imageIndex: 0 }), "f.lnkfig.md", extra, decoders);
  expect(first).toMatchObject({ kind: "image", src: "app://Notes/first.png", deps: ["Notes/analysis.md", "Notes/first.png"] });
  const second = await resolveFileNode(node({ file: "analysis", subpath: "#^all", imageIndex: 1 }), "f.lnkfig.md", extra, decoders);
  expect(second).toMatchObject({ kind: "image", src: "app://Notes/second.png", deps: ["Notes/analysis.md", "Notes/second.png"] });
});
test("an imageIndex past the last image is missing:no-image", async () => { expect(await resolveFileNode(node({ file: "analysis", subpath: "#Sec", imageIndex: 2 }), "f.lnkfig.md", extra, decoders)).toMatchObject({ kind: "missing", reason: "no-image", deps: ["Notes/analysis.md"] }); });
test("a note with an empty subpath shows its whole text as content", async () => { const r = await resolveFileNode(node({ file: "other-note", show: "content" }), "f.lnkfig.md", extra, decoders); expect(r).toMatchObject({ kind: "content", markdown: "# Other\n", deps: ["Notes/other-note.md"], file: { path: "Notes/other-note.md" } }); });
test("content slices to a bounded range", async () => { const r = await resolveFileNode(node({ file: "analysis", subpath: "#^fig2b", show: "content" }), "f.lnkfig.md", access, decoders); expect(r).toMatchObject({ kind: "content", markdown: "![[plot.png]] ^f" }); });
test("a pdf embedded in a note is decoded at the node's page", async () => {
  const withPdf = new FakeAccess({ files: { "n.md": "![[Notes/doc.pdf]]", "Notes/doc.pdf": "BINARY" }, embeds: { "n.md": [{ link: "Notes/doc.pdf", offset: 0 }] } });
  const r = await resolveFileNode(node({ file: "n", pageIndex: 1 }), "f.lnkfig.md", withPdf, decoders);
  expect(r).toMatchObject({ kind: "image", source: "pdf", src: "data:pdf", deps: ["n.md", "Notes/doc.pdf"] });
  expect(decoders.pdf).toHaveBeenCalledWith(expect.any(ArrayBuffer), 1, PDF_SCREEN_DPI / 72);
});
test("a tiff decoder failure is missing:decode", async () => { const bad = { ...decoders, tiff: vi.fn(async (..._args: unknown[]): Promise<DecodedImage> => { throw new Error("corrupt"); }) }; expect(await resolveFileNode(node({ file: "cells.tif" }), "f.lnkfig.md", access, bad)).toMatchObject({ kind: "missing", reason: "decode", deps: ["Notes/cells.tif"] }); });
test("only decoder errors become missing:decode", async () => {
  class FailingRead extends FakeAccess { override async readBinary(): Promise<ArrayBuffer> { throw new Error("io"); } }
  const broken = new FailingRead({ files: { "Notes/plot.pdf": "BINARY" } });
  await expect(resolveFileNode(node({ file: "plot.pdf" }), "f.lnkfig.md", broken, decoders)).rejects.toThrow("io");
});
