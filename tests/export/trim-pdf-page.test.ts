import { decodePDFRawStream, degrees, PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream, type PDFContext } from "@cantoo/pdf-lib";
import { readFileSync } from "node:fs";
import { PX_TO_PT } from "../../src/constants";
import type { PdfAsset } from "../../src/export/asset-types";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { trimAssets } from "../../src/export/trim";
import { tokenize } from "../../src/export/trim/pdf/tokenize";
import { pdfResourceInfo, TrimFallback, trimPdfPage } from "../../src/export/trim/pdf/trim-page";
import { findUnits, type Unit } from "../../src/export/trim/pdf/units";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import { nodeLabel } from "../../src/model/labels";
import type { FileNode } from "../../src/model/types";
import type { ExportInput } from "../../src/registry/exporter";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";

// The layered PDF export draws its SVG layers with jsPDF and svg2pdf.js, which need a browser: a stand-in hands back a
// real one-page PDF for each layer, so that pdf-lib composes a real output that can be read back.
const layerPdf = vi.hoisted(() => ({ bytes: undefined as ArrayBuffer | undefined }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    addPage() {}
    async svg() {}
    output(type: string) {
      return type === "arraybuffer" ? layerPdf.bytes?.slice(0) : new Blob(["%PDF"], { type: "application/pdf" });
    }
  },
}));
vi.mock("svg2pdf.js", () => ({}));

class FakeDOMParser {
  parseFromString(source: string) {
    return { documentElement: { source }, getElementsByTagName: () => [] };
  }
}

const own = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * A one-page PDF of the given size whose content is `content` (stored uncompressed, or with `filter`) and whose
 * resources are what `resources` builds, with helpers to make an image, a font and a form in the same document.
 */
async function pdfWith(
  content: string,
  resources: (make: Makers, context: PDFContext) => Record<string, unknown> = () => ({}),
  options: { size?: [number, number]; cropBox?: [number, number, number, number]; rotate?: number; filter?: string; decodeParms?: Record<string, unknown>; userUnit?: number; pages?: number } = {},
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const make = makers(context);
  for (let i = 0; i < (options.pages ?? 1); i++) {
    const page = doc.addPage(options.size ?? [200, 200]);
    page.node.set(PDFName.of("Resources"), context.obj(resources(make, context) as never));
    const stream = context.stream(content, {
      ...(options.filter ? { Filter: options.filter } : {}),
      ...(options.decodeParms ? { DecodeParms: options.decodeParms as never } : {}),
    });
    if (options.userUnit !== undefined) page.node.set(PDFName.of("UserUnit"), context.obj(options.userUnit));
    page.node.set(PDFName.of("Contents"), context.register(stream));
    if (options.cropBox) page.setCropBox(...options.cropBox);
    if (options.rotate) page.setRotation(degrees(options.rotate));
  }
  return own(await doc.save());
}

type Makers = ReturnType<typeof makers>;

function makers(context: PDFContext) {
  return {
    image: () =>
      context.register(
        context.stream(new Uint8Array([255, 0, 0]), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }),
      ),
    font: (base = "Helvetica") => context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: base })),
    form: (content: string, bbox: [number, number, number, number], resources?: Record<string, unknown>) =>
      context.register(
        context.stream(content, { Type: "XObject", Subtype: "Form", BBox: bbox, ...(resources ? { Resources: resources as never } : {}) }),
      ),
  };
}

/** Page 0 of a PDF as the trimmer left it: its decoded content, its resources and its boxes. */
async function read(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.lookup(PDFName.of("Contents"));
  const content = latin1(decodePDFRawStream(contents as PDFRawStream).decode());
  const resources = page.node.Resources()!;
  return { doc, page, content, resources, units: unitsOf(content, resources) };
}

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function unitsOf(content: string, resources: PDFDict | undefined): Unit[] {
  const bytes = enc(content);
  return findUnits(tokenize(bytes), bytes, pdfResourceInfo(resources), [1, 0, 0, 1, 0, 0]);
}

/** The names in a resource category, e.g. "XObject". */
function namesIn(resources: PDFDict, category: string): string[] {
  const sub = resources.lookupMaybe(PDFName.of(category), PDFDict);
  return sub ? sub.keys().map((k) => k.decodeText()).sort() : [];
}

/** A form XObject's decoded content, by its name in `resources`. */
function formContent(resources: PDFDict, name: string): { content: string; resources: PDFDict | undefined } {
  const form = resources.lookup(PDFName.of("XObject"), PDFDict).lookup(PDFName.of(name)) as PDFRawStream;
  return { content: latin1(decodePDFRawStream(form).decode()), resources: form.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) };
}

const count = (content: string, op: string) => tokenize(enc(content)).filter((t) => t.kind === "operator" && t.value === op).length;

// The visible region is the top-left quarter of a 200 × 200 page: in user space (y up), x 0–100 and y 100–200.
const TOP_LEFT = { x: 0, y: 0, width: 100, height: 100 };
const INSIDE = "10 150 20 20 re f";
const CROSSING = "90 150 20 20 re f";
const OUTSIDE = "150 20 20 20 re f";

test("a rectangle wholly outside is removed; the inside and crossing ones stay where they were", async () => {
  const source = await pdfWith(`q 0 0 1 rg ${INSIDE} Q q ${CROSSING} Q q ${OUTSIDE} Q`);
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  expect(trimmed.notes).toEqual([]);
  const out = await read(trimmed.bytes);
  expect(out.doc.getPageCount()).toBe(1);
  expect(out.units.map((u) => u.box)).toEqual(unitsOf(`${INSIDE} ${CROSSING}`, undefined).map((u) => u.box));
  expect(out.content).not.toContain(OUTSIDE);
  expect(out.content).toContain("0 0 1 rg");
  // Balanced: every q keeps its Q.
  expect([count(out.content, "q"), count(out.content, "Q")]).toEqual([3, 3]);
});

test("the visible region is measured from the top-left of the CropBox, and the page keeps its MediaBox and CropBox", async () => {
  // A 300 × 300 MediaBox cropped to x 50–250, y 50–250: the top-left 100 × 100 of the crop is x 50–150, y 150–250.
  const inside = "60 200 20 20 re f";
  const outside = "60 60 20 20 re f";
  const source = await pdfWith(`${inside} ${outside}`, () => ({}), { size: [300, 300], cropBox: [50, 50, 200, 200] });
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  const out = await read(trimmed.bytes);
  expect(out.content).toContain(inside);
  expect(out.content).not.toContain(outside);
  expect(out.page.getMediaBox()).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  expect(out.page.getCropBox()).toEqual({ x: 50, y: 50, width: 200, height: 200 });
});

test("a stroke whose path lies just outside but whose width, set by gs, reaches in is kept", async () => {
  // The line runs at y 95, 5 pt below the visible region; the ExtGState's 20 pt width reaches 10 pt either side.
  const reaching = "0 95 m 50 95 l S";
  const source = await pdfWith(`q /GS0 gs ${reaching} Q q ${reaching} Q`, () => ({ ExtGState: { GS0: { LW: 20 } } }));
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  const out = await read(trimmed.bytes);
  expect(out.content).toBe(`q /GS0 gs ${reaching} Q q  Q`);
});

test("the page asked for is the one trimmed, and the result has that page only", async () => {
  const source = await pdfWith(`${INSIDE} ${OUTSIDE}`, () => ({}), { pages: 3 });
  const trimmed = await trimPdfPage(source, 2, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  expect((await read(trimmed.bytes)).doc.getPageCount()).toBe(1);
});

test("an image, a font and a graphics state used only by removed drawings leave the resources; the others stay", async () => {
  const source = await pdfWith(
    `q /GSIn gs 20 0 0 20 10 150 cm /ImIn Do Q q 20 0 0 20 150 20 cm /ImOut Do Q ` +
      `BT /FIn 10 Tf 10 120 Td (Hi) Tj ET BT /FOut 10 Tf 150 50 Td (Hi) Tj ET`,
    (make) => ({
      XObject: { ImIn: make.image(), ImOut: make.image() },
      Font: { FIn: make.font(), FOut: make.font("Times-Roman") },
      ExtGState: { GSIn: { CA: 0.5 }, GSUnused: { CA: 0.5 } },
      ColorSpace: { CSUnused: "DeviceRGB" },
    }),
  );
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(2);
  const out = await read(trimmed.bytes);
  expect(namesIn(out.resources, "XObject")).toEqual(["ImIn"]);
  expect(namesIn(out.resources, "Font")).toEqual(["FIn"]);
  expect(namesIn(out.resources, "ExtGState")).toEqual(["GSIn"]);
  // Colour spaces (and marked-content properties) are not pruned: they are copied as they are.
  expect(namesIn(out.resources, "ColorSpace")).toEqual(["CSUnused"]);
});

test("a drawing wrapped whole in one form is trimmed inside the form, and the page draws the trimmed copy", async () => {
  const source = await pdfWith("q /Fm0 Do Q", (make) => ({
    XObject: { Fm0: make.form(`q ${INSIDE} Q q 20 0 0 20 150 20 cm /Im0 Do Q q ${OUTSIDE} Q`, [0, 0, 200, 200], { XObject: { Im0: make.image() } }) },
  }));
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(2);
  const out = await read(trimmed.bytes);
  expect(out.content).toBe("q /Fm0_lf1 Do Q");
  expect(namesIn(out.resources, "XObject")).toEqual(["Fm0_lf1"]);
  const form = formContent(out.resources, "Fm0_lf1");
  expect(form.content).toContain(INSIDE);
  expect(form.content).not.toContain(OUTSIDE);
  expect(form.content).not.toContain("/Im0");
  // The copy's own resources are pruned too.
  expect(namesIn(form.resources!, "XObject")).toEqual([]);
  expect([count(form.content, "q"), count(form.content, "Q")]).toEqual([3, 3]);
});

test("a form used twice, once inside and once outside: the outside use goes, the inside one keeps the original form", async () => {
  const source = await pdfWith("q 1 0 0 1 10 150 cm /Fm1 Do Q q 1 0 0 1 150 10 cm /Fm1 Do Q", (make) => ({
    XObject: { Fm1: make.form("0 0 20 20 re f", [0, 0, 20, 20], {}) },
  }));
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  const out = await read(trimmed.bytes);
  expect(count(out.content, "Do")).toBe(1);
  expect(out.content).toContain("/Fm1 Do");
  expect(namesIn(out.resources, "XObject")).toEqual(["Fm1"]);
  expect(formContent(out.resources, "Fm1").content).toBe("0 0 20 20 re f");
});

test("a form crossing the edge with nothing outside inside it is kept as it is", async () => {
  const source = await pdfWith("/Fm0 Do", (make) => ({ XObject: { Fm0: make.form(`${INSIDE} ${CROSSING}`, [0, 0, 200, 200], {}) } }));
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  expect(trimmed.removed).toBe(0);
  expect(namesIn((await read(trimmed.bytes)).resources, "XObject")).toEqual(["Fm0"]);
});

test("a form name that needs escaping keeps its escape in the copy's name", async () => {
  const source = await pdfWith("/Fm#200 Do", (make) => ({
    XObject: { "Fm#200": make.form(`${INSIDE} ${OUTSIDE}`, [0, 0, 200, 200], {}) },
  }));
  const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
  const out = await read(trimmed.bytes);
  expect(out.content).toBe("/Fm#200_lf1 Do");
  expect(namesIn(out.resources, "XObject")).toEqual(["Fm 0_lf1"]);
});

/** Forms nested `levels` deep, each drawing the next, the innermost an inside and an outside rectangle. */
function nested(levels: number) {
  return pdfWith("/Fm1 Do", (make) => {
    let inner = make.form(`${INSIDE} ${OUTSIDE}`, [0, 0, 200, 200], {});
    for (let level = levels; level > 1; level--) inner = make.form(`/Fm${level} Do`, [0, 0, 200, 200], { XObject: { [`Fm${level}`]: inner } });
    return { XObject: { Fm1: inner } };
  });
}

test("forms nested 8 deep are trimmed at every level", async () => {
  const trimmed = await trimPdfPage(await nested(8), 0, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  expect(trimmed.notes).toEqual([]);
  let level = await read(trimmed.bytes);
  let resources = level.resources;
  let content = level.content;
  for (let depth = 1; depth <= 8; depth++) {
    const name = `Fm${depth}_lf${9 - depth}`;
    expect(content).toBe(`/${name} Do`);
    // Each level's resources name only the copy below it.
    expect(namesIn(resources, "XObject")).toEqual([name]);
    ({ content, resources } = formContent(resources, name) as { content: string; resources: PDFDict });
  }
  expect(content).toBe(`${INSIDE} `);
});

test("a form nested deeper than 8 is kept whole, and said so", async () => {
  const trimmed = await trimPdfPage(await nested(9), 0, TOP_LEFT);
  expect(trimmed.removed).toBe(0);
  expect(trimmed.notes).toEqual(["a nested drawing deeper than 8 levels was kept whole"]);
});

describe("drawings that read the page's resources (no Resources of their own)", () => {
  // OUTSIDE_IMAGE is the only use of /ImOut, so it goes; what the borrowing drawing names must stay.
  const OUTSIDE_IMAGE = "q 20 0 0 20 150 20 cm /ImOut Do Q";

  test("a marker form: its names stay, an image only drawn outside goes", async () => {
    const source = await pdfWith(`q 1 0 0 1 10 150 cm /M0 Do Q ${OUTSIDE_IMAGE}`, (make) => ({
      XObject: { M0: make.form("/GSm gs q 5 0 0 5 0 0 cm /ImM Do Q", [0, 0, 5, 5]), ImM: make.image(), ImOut: make.image() },
      ExtGState: { GSm: { CA: 0.5 } },
    }));
    const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
    expect(trimmed.removed).toBe(1);
    expect(trimmed.notes).toEqual([]);
    const out = await read(trimmed.bytes);
    expect(namesIn(out.resources, "XObject")).toEqual(["ImM", "M0"]);
    expect(namesIn(out.resources, "ExtGState")).toEqual(["GSm"]);
  });

  test("a marker form drawn only outside takes its names with it", async () => {
    const source = await pdfWith(`${INSIDE} q 1 0 0 1 150 20 cm /M0 Do Q`, (make) => ({
      XObject: { M0: make.form("/GSm gs 0 0 5 5 re f", [0, 0, 5, 5]) },
      ExtGState: { GSm: { CA: 0.5 } },
    }));
    const out = await read((await trimPdfPage(source, 0, TOP_LEFT)).bytes);
    expect(namesIn(out.resources, "XObject")).toEqual([]);
    expect(namesIn(out.resources, "ExtGState")).toEqual([]);
  });

  test("a Type 3 font whose glyph draws an XObject keeps it", async () => {
    const source = await pdfWith(`BT /T3 10 Tf 10 150 Td (a) Tj ET ${OUTSIDE_IMAGE}`, (make, context) => ({
      Font: {
        T3: {
          Type: "Font",
          Subtype: "Type3",
          FontBBox: [0, 0, 1, 1],
          FontMatrix: [1, 0, 0, 1, 0, 0],
          FirstChar: 97,
          LastChar: 97,
          Widths: [1],
          Encoding: { Type: "Encoding", Differences: [97, "a"] },
          CharProcs: { a: context.register(context.stream("1 0 0 0 1 1 d1 /ImG Do")) },
        },
      },
      XObject: { ImG: make.image(), ImOut: make.image() },
    }));
    const out = await read((await trimPdfPage(source, 0, TOP_LEFT)).bytes);
    expect(namesIn(out.resources, "XObject")).toEqual(["ImG"]);
    expect(namesIn(out.resources, "Font")).toEqual(["T3"]);
  });

  test("a Type 3 font set by an ExtGState keeps what its glyphs draw", async () => {
    const source = await pdfWith(`q /GSf gs BT 10 150 Td (a) Tj ET Q ${OUTSIDE_IMAGE}`, (make, context) => ({
      ExtGState: {
        GSf: {
          Font: [
            context.obj({
              Type: "Font",
              Subtype: "Type3",
              FontBBox: [0, 0, 1, 1],
              FontMatrix: [1, 0, 0, 1, 0, 0],
              FirstChar: 97,
              LastChar: 97,
              Widths: [1],
              Encoding: { Type: "Encoding", Differences: [97, "a"] },
              CharProcs: { a: context.register(context.stream("1 0 0 0 1 1 d1 /ImG Do")) },
            }),
            10,
          ],
        },
      },
      XObject: { ImG: make.image(), ImOut: make.image() },
    }));
    const out = await read((await trimPdfPage(source, 0, TOP_LEFT)).bytes);
    expect(namesIn(out.resources, "XObject")).toEqual(["ImG"]);
    expect(namesIn(out.resources, "ExtGState")).toEqual(["GSf"]);
  });

  test("a tiling pattern and a soft mask group keep what they draw", async () => {
    const source = await pdfWith(`q /GSs gs /Pattern cs /P0 scn ${INSIDE} Q ${OUTSIDE_IMAGE}`, (make, context) => ({
      Pattern: {
        P0: context.register(
          context.stream("/ImP Do", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1 }),
        ),
      },
      ExtGState: { GSs: { SMask: { S: "Luminosity", G: make.form("/ImS Do", [0, 0, 200, 200]) } } },
      XObject: { ImP: make.image(), ImS: make.image(), ImOut: make.image() },
    }));
    const out = await read((await trimPdfPage(source, 0, TOP_LEFT)).bytes);
    expect(namesIn(out.resources, "XObject")).toEqual(["ImP", "ImS"]);
    expect(namesIn(out.resources, "Pattern")).toEqual(["P0"]);
  });

  test("a resource-less form inside a form with resources is kept whole, so what it draws keeps its resource", async () => {
    // P has its own resources, holding N and Im; N has none and draws /Im, which only P's resources hold.
    const source = await pdfWith("/P Do", (make) => {
      const n = make.form(`q 20 0 0 20 10 150 cm /Im Do Q ${OUTSIDE}`, [0, 0, 200, 200]);
      return { XObject: { P: make.form(`/N Do ${OUTSIDE}`, [0, 0, 200, 200], { XObject: { N: n, Im: make.image() } }) } };
    });
    const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
    // P's own outside rectangle goes; N is not rewritten.
    expect(trimmed.removed).toBe(1);
    const out = await read(trimmed.bytes);
    expect(out.content).toBe("/P_lf1 Do");
    const p = formContent(out.resources, "P_lf1");
    expect(p.content).toBe("/N Do ");
    expect(namesIn(p.resources!, "XObject")).toEqual(["Im", "N"]);
    expect(formContent(p.resources!, "N").content).toBe(`q 20 0 0 20 10 150 cm /Im Do Q ${OUTSIDE}`);
  });

  test("a Resources entry that is not a dictionary counts as none", async () => {
    const source = await pdfWith(`q 1 0 0 1 10 150 cm /M0 Do Q q 20 0 0 20 150 20 cm /ImOut Do Q /Fm Do`, (make, context) => ({
      XObject: {
        M0: context.register(context.stream("q 5 0 0 5 0 0 cm /ImM Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 5, 5], Resources: 7 })),
        Fm: context.register(context.stream(`${INSIDE} ${OUTSIDE}`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200], Resources: "Bad" })),
        ImM: make.image(),
        ImOut: make.image(),
      },
    }));
    const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
    // Fm crosses the edge and is trimmed with the page's resources; M0's image stays, the outside one goes.
    expect(trimmed.removed).toBe(2);
    const out = await read(trimmed.bytes);
    expect(namesIn(out.resources, "XObject")).toEqual(["Fm_lf1", "ImM", "M0"]);
  });

  test("a borrowing drawing that cannot be read keeps every resource, and says so", async () => {
    const source = await pdfWith(`q 1 0 0 1 10 150 cm /M0 Do Q ${OUTSIDE_IMAGE}`, (make, context) => ({
      XObject: {
        M0: context.register(context.stream("garbage", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 5, 5], Filter: "DCTDecode" })),
        ImOut: make.image(),
      },
    }));
    const trimmed = await trimPdfPage(source, 0, TOP_LEFT);
    expect(trimmed.removed).toBe(1);
    expect(trimmed.notes).toEqual(["unused resources could not be dropped"]);
    expect(namesIn((await read(trimmed.bytes)).resources, "XObject")).toEqual(["ImOut", "M0"]);
  });

  test("a matplotlib plot (markers as forms, a Type 3 font): the image drawn only outside is dropped", async () => {
    // Scatter, imshow and text on a 288 × 288 pt page; the image /I1 lies wholly outside its top-left quarter.
    const file = readFileSync(new URL("./fixtures/matplotlib-scatter.pdf", import.meta.url));
    const trimmed = await trimPdfPage(own(file), 0, { x: 0, y: 0, width: 144, height: 144 });
    expect(trimmed.removed).toBeGreaterThan(0);
    expect(trimmed.notes).toEqual([]);
    const out = await read(trimmed.bytes);
    expect(out.content).not.toContain("/I1 Do");
    expect(namesIn(out.resources, "XObject")).toEqual(["M0"]);
    expect(namesIn(out.resources, "Font")).toEqual(["F1"]);
  });

  test("a matplotlib plot's tick labels and text in its Type 3 font are removed where they lie wholly outside", async () => {
    const file = readFileSync(new URL("./fixtures/matplotlib-scatter.pdf", import.meta.url));
    // The crop of the manual check: in user space x 57.6–288, y 144–288, the top of the plot's right part.
    const trimmed = await trimPdfPage(own(file), 0, { x: 57.6, y: 0, width: 230.4, height: 144 });
    // Before Type 3 text could be measured, 16 drawings went and every label stayed.
    expect(trimmed.removed).toBeGreaterThan(16);
    const out = await read(trimmed.bytes);
    for (const label of ["(OUTSIDE)", "(0.0)", "(0.2)", "(0.4)", "(1.0)"]) expect(out.content).not.toContain(label);
    const visible = { x: 57.6, y: 144, width: 230.4, height: 144 };
    const outside = (b: { x: number; y: number; width: number; height: number }) =>
      b.x > visible.x + visible.width || b.x + b.width < visible.x || b.y > visible.y + visible.height || b.y + b.height < visible.y;
    expect(out.units.filter((u) => u.kind === "text" && u.box && outside(u.box))).toEqual([]);
    expect(namesIn(out.resources, "Font")).toEqual([]);

    // A crop around the OUTSIDE label (at x 214, y 76 in user space) keeps it, and drops the tick labels.
    const around = await trimPdfPage(own(file), 0, { x: 200, y: 190, width: 88, height: 30 });
    const kept = await read(around.bytes);
    expect(kept.content).toContain("(OUTSIDE)");
    expect(kept.content).not.toContain("(0.0)");
    expect(kept.units.filter((u) => u.kind === "text")).toHaveLength(1);
    expect(namesIn(kept.resources, "Font")).toEqual(["F1"]);
  });
});

test("a file with only an owner password is trimmed, and the result is not encrypted", async () => {
  const doc = await PDFDocument.load(await pdfWith(`${INSIDE} ${OUTSIDE}`));
  doc.encrypt({ ownerPassword: "owner" });
  const trimmed = await trimPdfPage(own(await doc.save()), 0, TOP_LEFT);
  expect(trimmed.removed).toBe(1);
  expect((await read(trimmed.bytes)).content).toContain(INSIDE);
});

describe("pages that cannot be trimmed safely", () => {
  test("a content stream in a filter that cannot be decoded", async () => {
    const source = await pdfWith(INSIDE, () => ({}), { filter: "DCTDecode" });
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(TrimFallback);
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow("DCTDecode");
  });

  test("a content stream that cannot be read", async () => {
    const source = await pdfWith(`${INSIDE} BT ${OUTSIDE}`);
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(TrimFallback);
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(/could not be read/);
  });

  test("a content stream with a predictor, which pdf-lib would not undo", async () => {
    const source = await pdfWith(INSIDE, () => ({}), { filter: "FlateDecode", decodeParms: { Predictor: 12, Columns: 4 } });
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(new TrimFallback("a content stream uses a predictor, which cannot be decoded"));
  });

  test("a filter by its abbreviated name, which pdf-lib does not know", async () => {
    const source = await pdfWith(INSIDE, () => ({}), { filter: "Fl" });
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(new TrimFallback("a content stream is encoded with Fl, which cannot be decoded"));
  });

  test("a page with a UserUnit other than 1; a UserUnit of 1 is trimmed", async () => {
    const source = await pdfWith(`${INSIDE} ${OUTSIDE}`, () => ({}), { userUnit: 2 });
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(new TrimFallback("the page uses a UserUnit"));
    expect((await trimPdfPage(await pdfWith(`${INSIDE} ${OUTSIDE}`, () => ({}), { userUnit: 1 }), 0, TOP_LEFT)).removed).toBe(1);
  });

  test("a page with a rotation of its own", async () => {
    const source = await pdfWith(`${INSIDE} ${OUTSIDE}`, () => ({}), { rotate: 90 });
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(new TrimFallback("the page has a rotation of its own"));
  });

  test("a page whose CropBox reaches outside its MediaBox", async () => {
    const source = await pdfWith(`${INSIDE} ${OUTSIDE}`, () => ({}), { cropBox: [-10, 0, 200, 200] });
    await expect(trimPdfPage(source, 0, TOP_LEFT)).rejects.toThrow(new TrimFallback("the page's CropBox reaches outside its MediaBox"));
  });

  test("a file that is not a PDF", async () => {
    await expect(trimPdfPage(own(enc("not a pdf")), 0, TOP_LEFT)).rejects.toThrow(TrimFallback);
  });

  test("trimAssets keeps the original asset and reports why", async () => {
    const source = await pdfWith(`${INSIDE} BT ${OUTSIDE}`);
    const { doc, page, node, asset } = croppedPanel(source);
    const report: string[] = [];
    const out = await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report, "vector");
    expect(out.get(node.id)).toBe(asset);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatch(new RegExp(`^${escapeRe(nodeLabel(doc, node))}: could not be trimmed, embedded whole \\(the page's content could not be read: .+\\)$`));
  });
});

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const deps = {
  cutImage: async () => {
    throw new Error("not used");
  },
  trimSvg: async () => {
    throw new Error("not used");
  },
  trimPdf: trimPdfPage,
};

/** A figure with one PDF panel showing the top-left quarter of a 200 × 200 pt page, at 100 × 100 pt. */
function croppedPanel(bytes: ArrayBuffer) {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const node: FileNode = {
    ...fileNodeDefaults(page, { file: "plot.pdf", subpath: "", show: "image" }, []),
    x: 20 / PX_TO_PT,
    y: 20 / PX_TO_PT,
    width: 100 / PX_TO_PT,
    height: 100 / PX_TO_PT,
    fit: "contain",
    crop: { x: 0, y: 0, w: 0.5, h: 0.5 },
  };
  doc.nodes.push(node);
  const asset: PdfAsset = { kind: "pdf", bytes, pageIndex: 0, widthPt: 200, heightPt: 200, raster: "data:image/png;base64,", rasterWidth: 1, rasterHeight: 1 };
  return { doc, page, node, asset };
}

describe("through the PDF export", () => {
  beforeAll(async () => {
    const layer = await PDFDocument.create();
    layer.addPage([10, 10]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
    layerPdf.bytes = own(await layer.save());
  });
  beforeEach(() => vi.stubGlobal("DOMParser", FakeDOMParser));
  afterEach(() => vi.unstubAllGlobals());

  test("the exported page still draws the panel's inside rectangle, from the trimmed page, at the same place", async () => {
    // The source's page 2 of 2 is the panel's; the trimmed asset holds it as page 0.
    const source = await pdfWith(`q 0 0 1 rg ${INSIDE} Q q ${OUTSIDE} Q`, () => ({}), { pages: 2 });
    const { doc, page, node, asset } = croppedPanel(source);
    const report: string[] = [];
    const trimmed = (await trimAssets(doc, page, new Map([[node.id, { ...asset, pageIndex: 1 }]]), deps, report, "vector")).get(node.id) as PdfAsset;
    expect(report).toEqual([`${nodeLabel(doc, node)}: 1 item outside the crop removed`]);
    expect([trimmed.pageIndex, trimmed.widthPt, trimmed.heightPt]).toEqual([0, 200, 200]);

    const types = createRegistries();
    types.nodeTypes.register({
      type: "file",
      name: "file",
      icon: "",
      mount: () => ({ update() {}, unmount() {} }),
      bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      inspector: () => [],
      toSvg: () => "",
    } as unknown as NodeType);
    const drawPage = vi.spyOn(PDFPage.prototype, "drawPage");
    const input: ExportInput = {
      doc,
      pages: doc.pages,
      svgs: new Map([[page.id, "<svg/>"]]),
      assets: new Map([[page.id, new Map([[node.id, trimmed]])]]),
      registries: types,
      warnings: [],
      baseName: "fig",
      dpi: 300,
    };
    const { files } = await pdfExporter.run(input, {});
    // Placed as the untrimmed page would be: the crop's 100 × 100 pt at the node's rectangle.
    const placed = drawPage.mock.calls[1][1]!;
    expect(placed).toMatchObject({ x: expect.closeTo(20), width: expect.closeTo(100), height: expect.closeTo(100) });

    const out = await PDFDocument.load(await files[0].blob.arrayBuffer());
    const xobjects = out.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const drawn = xobjects.keys().map((key) => latin1(decodePDFRawStream(xobjects.lookup(key) as PDFRawStream).decode()));
    expect(drawn.some((content) => content.includes(INSIDE))).toBe(true);
    expect(drawn.some((content) => content.includes(OUTSIDE))).toBe(false);
    drawPage.mockRestore();
  });
});

describe("what the units are told of the resources", () => {
  async function info(resources: (make: Makers, context: PDFContext) => Record<string, unknown>) {
    const doc = await PDFDocument.load(await pdfWith("", resources));
    return pdfResourceInfo(doc.getPage(0).node.Resources());
  }

  test("a simple font's widths, with the descriptor's MissingWidth; none for a standard font without them", async () => {
    const res = await info(() => ({
      Font: {
        F1: { Type: "Font", Subtype: "TrueType", FirstChar: 32, Widths: [250, 500], FontDescriptor: { MissingWidth: 300 } },
        F2: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" },
      },
    }));
    expect(res.font("F1")).toEqual({ widths: { first: 32, list: [250, 500], missing: 300 }, twoByte: false });
    expect(res.font("F2")).toEqual({ widths: null, twoByte: false });
  });

  describe("Type 3 fonts", () => {
    async function type3(fontBBox: number[], procs: Record<string, string | { content: string; filter: string }>, extra: Record<string, unknown> = {}) {
      const res = await info((_, c) => {
        const charProcs: Record<string, unknown> = {};
        for (const [name, proc] of Object.entries(procs)) {
          charProcs[name] = typeof proc === "string" ? c.register(c.stream(proc)) : c.register(c.stream(proc.content, { Filter: proc.filter }));
        }
        return {
          Font: {
            T3: { Type: "Font", Subtype: "Type3", FontBBox: fontBBox, FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: charProcs, FirstChar: 65, Widths: [600, 500], ...extra },
          },
        };
      });
      return res.font("T3");
    }

    test("its FontMatrix, FontBBox and widths (in glyph space), the bbox widened by any larger d1 box", async () => {
      expect(await type3([0, -200, 600, 800], { A: "600 0 0 -100 500 700 d1 0 0 m f", B: "500 0 -50 0 400 900 d1" })).toEqual({
        widths: { first: 65, list: [600, 500], missing: 0 },
        twoByte: false,
        glyphSpace: { matrix: [0.001, 0, 0, 0.001, 0, 0], bbox: [-50, -200, 600, 900] },
      });
    });

    test("a FontBBox of zeros: the union of the glyphs' d1 boxes, when every glyph declares one", async () => {
      const font = await type3([0, 0, 0, 0], { A: "600 0 500 700 0 -100 d1", B: "500 0 -20 0 300 400 d1 0 0 m f" });
      expect(font?.glyphSpace?.bbox).toEqual([-20, -100, 500, 700]);
    });

    test("with a FontBBox, glyphs that begin with d0 or cannot be read add nothing", async () => {
      const font = await type3([0, -200, 600, 800], { A: "500 0 d0 0 0 m 900 900 l S", B: { content: "x", filter: "DCTDecode" } });
      expect(font?.glyphSpace?.bbox).toEqual([0, -200, 600, 800]);
    });

    test("a FontBBox of zeros with a glyph that does not declare its box (d0, or unreadable): not measured", async () => {
      expect(await type3([0, 0, 0, 0], { A: "600 0 500 700 0 -100 d1", B: "500 0 d0 0 0 m 900 900 l S" })).toBeNull();
      expect(await type3([0, 0, 0, 0], { A: "600 0 500 700 0 -100 d1", B: { content: "x", filter: "DCTDecode" } })).toBeNull();
    });

    test("not measured with neither a FontBBox nor a d1 box, or with a FontMatrix or widths that cannot be read", async () => {
      expect(await type3([0, 0, 0, 0], { A: "600 0 d0 0 0 m 900 900 l S", B: { content: "x", filter: "DCTDecode" } })).toBeNull();
      expect(await type3([0, 0, 0, 0], {})).toBeNull();
      expect(await type3([0, -200, 600, 800], {}, { FontMatrix: [0.001, 0, 0] })).toBeNull();
      expect(await type3([0, -200, 600, 800], {}, { Widths: [600, "x"] })).toBeNull();
    });
  });

  test("Type 3 fonts without glyphs to read, vertical writing, malformed widths and unknown names are not measured", async () => {
    const res = await info(() => ({
      Font: {
        T3: { Type: "Font", Subtype: "Type3" },
        V: { Type: "Font", Subtype: "Type0", Encoding: "Identity-V", DescendantFonts: [{ Subtype: "CIDFontType2" }] },
        Bad: { Type: "Font", Subtype: "Type1", FirstChar: 0, Widths: [100, "x"] },
      },
    }));
    expect(res.font("T3")).toBeNull();
    expect(res.font("V")).toBeNull();
    expect(res.font("Bad")).toBeNull();
    expect(res.font("Nope")).toBeNull();
  });

  test("a horizontal composite font counts two bytes a glyph, with its widths from W and DW", async () => {
    const res = await info(() => ({
      Font: { H: { Type: "Font", Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: [{ Subtype: "CIDFontType2", DW: 900, W: [1, [500, 1200], 10, 20, 700] }] } },
    }));
    expect(res.font("H")).toEqual({ widths: { first: 0, list: [500, 1200, 700], missing: 900 }, twoByte: true });
  });

  test("an ExtGState's line style and font; null when it, or one of those entries, cannot be read", async () => {
    const res = await info((make) => ({
      ExtGState: {
        GS0: { LW: 20, LC: 2, LJ: 1, ML: 4, CA: 0.5 },
        GSf: { Font: [make.font(), 12] },
        Plain: { CA: 0.5 },
        BadLW: { LW: "x" },
        BadFont: { Font: [make.font()] },
        NotDict: 3,
      },
    }));
    expect(res.extGState("GS0")).toEqual({ lineWidth: 20, cap: 2, join: 1, miterLimit: 4 });
    expect(res.extGState("GSf")).toEqual({ font: { font: { widths: null, twoByte: false }, size: 12 } });
    expect(res.extGState("Plain")).toEqual({});
    for (const name of ["BadLW", "BadFont", "NotDict", "Nope"]) expect(res.extGState(name)).toBeNull();
  });

  test("forms with their BBox and Matrix, images, and shadings with their BBox", async () => {
    const res = await info((make) => ({
      XObject: { Im: make.image(), Fm: make.form("", [0, 0, 10, 20], {}) },
      Shading: { Sh: { ShadingType: 2, BBox: [1, 2, 3, 4] }, NoBox: { ShadingType: 2 } },
    }));
    expect(res.xobject("Im")).toEqual({ subtype: "Image" });
    expect(res.xobject("Fm")).toEqual({ subtype: "Form", bbox: [0, 0, 10, 20], matrix: [1, 0, 0, 1, 0, 0] });
    expect(res.xobject("Nope")).toBeNull();
    expect(res.shadingBBox("Sh")).toEqual([1, 2, 3, 4]);
    expect(res.shadingBBox("NoBox")).toBeNull();
  });
});
