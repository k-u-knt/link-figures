import { createPptxExporter } from "../../src/export/exporters/pptx";
import { buildPptx } from "../../src/export/pptx/package";
import { notesMasterXml, notesSlideXml } from "../../src/export/pptx/notes";
import { createDocument, createPage } from "../../src/model/defaults";
import type { Document, PageId } from "../../src/model/types";
import type { ExportInput } from "../../src/registry/exporter";
import { createApi } from "../../src/api";
import { PNG_BYTES, pptxRegistries } from "./pptx/context";
import { all, one, parseXml, unzipText } from "./pptx/ooxml";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const backend = { renderClearPng: async () => PNG_BYTES };
const CREATED = new Date("2026-11-10T00:00:00Z");

/** Pages: two A4 (pg-1, pg-3) and one of another size between them (pg-2). */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  doc.pages.push({ ...createPage("nature-double", ["pg-1"]), id: "pg-2" }, { ...createPage("a4-portrait", ["pg-1", "pg-2"]), id: "pg-3" });
  return doc;
}

async function run(doc: Document, cards: Record<PageId, string[]>, opts: Record<string, unknown>) {
  const asked: PageId[] = [];
  const input: ExportInput = {
    doc,
    pages: doc.pages,
    svgs: new Map(),
    assets: new Map(),
    registries: pptxRegistries(),
    warnings: [],
    baseName: "Fig",
    dpi: 150,
    cardMarkdown: async (page) => {
      asked.push(page);
      return cards[page] ?? [];
    },
  };
  const result = await createPptxExporter(backend, () => CREATED).run(input, opts);
  const files = await Promise.all(result.files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.blob.arrayBuffer()) })));
  return { files, asked };
}

const CARDS = { "pg-1": ["# Legend\n\n**A**, cortex ![[x.png]]\n- one\n- two", "Second card"], "pg-2": ["Size two"] };

describe("notes parts", () => {
  test("a notes slide holds the text as paragraphs in its body placeholder, under the slide image; the master has both placeholders", () => {
    const slide = parseXml(notesSlideXml("Line <1> & more\n\nAfter"));
    // The slide's picture above (PowerPoint's Notes Page thumbnail), the notes below.
    expect(all(slide, "p:ph").map((p) => p.getAttribute("type"))).toEqual(["sldImg", "body"]);
    expect(all(slide, "a:p").map((p) => all(p, "a:t").map((t) => t.textContent).join(""))).toEqual(["Line <1> & more", "", "After"]);
    const master = parseXml(notesMasterXml());
    expect(all(master, "p:ph").map((p) => p.getAttribute("type"))).toEqual(["sldImg", "body"]);
    expect(all(master, "p:notesStyle")).toHaveLength(1);
  });
});

describe("pptx presenter notes", () => {
  test("notes on: each slide with cards has a notesSlide with the plain text, and a notesMaster with relationships and content types", async () => {
    const { files } = await run(figure(), CARDS, { notes: true });
    const parts = unzipText(files[0].bytes);
    // File 1: pg-1 (slide 1, with cards) and pg-3 (slide 2, none).
    const notes = parseXml(parts.get("ppt/notesSlides/notesSlide1.xml")!);
    expect(all(notes, "a:p").map((p) => all(p, "a:t").map((t) => t.textContent).join(""))).toEqual(["Legend", "", "A, cortex", "• one", "• two", "", "Second card"]);
    expect(parts.has("ppt/notesSlides/notesSlide2.xml")).toBe(false);
    expect(parts.has("ppt/notesMasters/notesMaster1.xml")).toBe(true);

    const types = parts.get("[Content_Types].xml")!;
    expect(types).toContain('<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>');
    expect(types).toContain('<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>');
    expect(types).toContain('<Override PartName="/ppt/theme/theme2.xml"');

    const slideRels = parts.get("ppt/slides/_rels/slide1.xml.rels")!;
    expect(slideRels).toMatch(/Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/notesSlide" Target="..\/notesSlides\/notesSlide1.xml"/);
    expect(parts.get("ppt/slides/_rels/slide2.xml.rels")).not.toContain("notesSlide");
    const notesRels = parts.get("ppt/notesSlides/_rels/notesSlide1.xml.rels")!;
    expect(notesRels).toContain('Target="../notesMasters/notesMaster1.xml"');
    expect(notesRels).toContain('Target="../slides/slide1.xml"');
    expect(parts.get("ppt/notesMasters/_rels/notesMaster1.xml.rels")).toContain('Target="../theme/theme2.xml"');

    const pres = parseXml(parts.get("ppt/presentation.xml")!);
    const masterRId = one(pres, "p:notesMasterId").getAttribute("r:id")!;
    expect(parts.get("ppt/_rels/presentation.xml.rels")).toContain(`<Relationship Id="${masterRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>`);
    // Schema order: the notes master list comes between the slide master list and the slide list.
    const order = Array.from(pres.documentElement.children).map((c) => c.tagName);
    expect(order.slice(0, 3)).toEqual(["p:sldMasterIdLst", "p:notesMasterIdLst", "p:sldIdLst"]);
    for (const [name, xml] of parts) if (name.endsWith(".xml") || name.endsWith(".rels")) parseXml(xml);
  });

  test("notes off: the package is byte-identical to before", async () => {
    const doc = figure();
    const off = await run(doc, CARDS, {});
    expect(off.asked).toEqual([]);
    const plain = await createPptxExporter(backend, () => CREATED).run(
      { doc, pages: doc.pages, svgs: new Map(), assets: new Map(), registries: pptxRegistries(), warnings: [], baseName: "Fig", dpi: 150 },
      {},
    );
    for (const [i, f] of plain.files.entries()) expect(off.files[i].bytes).toEqual(new Uint8Array(await f.blob.arrayBuffer()));
    // buildPptx without notes is unchanged by the notes code: no notes parts.
    const bytes = buildPptx({ sizeEmu: { cx: 914400 * 2, cy: 914400 * 2 }, slides: [{ xml: "", media: [] }], created: CREATED });
    expect([...unzipText(bytes).keys()].some((n) => /notes/i.test(n))).toBe(false);
    // On, with no cards anywhere: no notes parts either.
    const none = await run(doc, {}, { notes: true });
    for (const [i, f] of none.files.entries()) expect(f.bytes).toEqual(off.files[i].bytes);
  });

  test("the per-page-size files each carry their own slides' notes", async () => {
    const { files } = await run(figure(), CARDS, { notes: true });
    expect(files.map((f) => f.name)).toEqual(["Fig.pptx", "Fig (183×170 mm).pptx"]);
    const second = unzipText(files[1].bytes);
    const notes = parseXml(second.get("ppt/notesSlides/notesSlide1.xml")!);
    expect(all(notes, "a:t").map((t) => t.textContent)).toEqual(["Size two"]);
    expect(second.get("ppt/notesSlides/_rels/notesSlide1.xml.rels")).toContain('Target="../slides/slide1.xml"');
  });

  test('`options.notes` with format svg is refused: `api.export: "notes" is a PowerPoint option`', async () => {
    const r = pptxRegistries();
    r.exporters.register({ id: "svg", name: "SVG", ext: "svg", mime: "image/svg+xml", pdfPanels: "vector", options: () => [], run: async () => ({ files: [], warnings: [] }) });
    r.exporters.register(createPptxExporter(backend));
    const exportFigure = vi.fn(async () => ({ files: [], warnings: [] }));
    const api = createApi({ app: {} as never, registries: r, files: {} as never, normalizePath: (p) => p, openFigure: () => null, exportFigure });
    await expect(api.export("F.lnkfig.md", { format: "svg", options: { notes: true } })).rejects.toThrow('api.export: "notes" is a PowerPoint option');
    expect(exportFigure).not.toHaveBeenCalled();
    await api.export("F.lnkfig.md", { format: "pptx", options: { notes: true } });
    expect(exportFigure).toHaveBeenCalledTimes(1);
  });
});
