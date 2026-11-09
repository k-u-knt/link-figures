import { buildPptx, slideMediaRId, type PptxPackageInput } from "../../../src/export/pptx/package";
import { all, one, parseXml, unzip, unzipText } from "./ooxml";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const SP = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>';

const input = (over: Partial<PptxPackageInput> = {}): PptxPackageInput => ({
  sizeEmu: { cx: 6480000, cy: 3600000 },
  slides: [
    { xml: SP, background: "#fafafa", media: [{ name: "image1.png", bytes: PNG, contentType: "image/png" }] },
    { xml: "", media: [{ name: "image1.png", bytes: PNG, contentType: "image/png" }, { name: "photo.jpeg", bytes: JPEG, contentType: "image/jpeg" }] },
  ],
  created: new Date("2026-11-10T12:00:00Z"),
  title: "Fig <1> & \"2\"",
  ...over,
});

const FIXED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/app.xml",
  "docProps/core.xml",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
  "ppt/presProps.xml",
  "ppt/viewProps.xml",
  "ppt/tableStyles.xml",
  "ppt/slideMasters/slideMaster1.xml",
  "ppt/slideMasters/_rels/slideMaster1.xml.rels",
  "ppt/slideLayouts/slideLayout1.xml",
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  "ppt/theme/theme1.xml",
];

const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

/** The part a relationship's target names, resolved against the folder of the part the rels file belongs to. */
function resolveTarget(relsPath: string, target: string): string {
  const owner = relsPath === "_rels/.rels" ? "" : relsPath.replace(/_rels\/([^/]+)\.rels$/, "$1");
  const parts = owner.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

describe("buildPptx", () => {
  const files = unzipText(buildPptx(input()));

  it("writes the fixed parts, one part per slide with its rels, and the media", () => {
    expect([...files.keys()].sort()).toEqual(
      [
        ...FIXED_PARTS,
        "ppt/slides/slide1.xml",
        "ppt/slides/_rels/slide1.xml.rels",
        "ppt/slides/slide2.xml",
        "ppt/slides/_rels/slide2.xml.rels",
        "ppt/media/image1.png",
        "ppt/media/image1-2.png",
        "ppt/media/photo.jpeg",
      ].sort(),
    );
    // [Content_Types].xml first, as OPC readers expect.
    expect([...files.keys()][0]).toBe("[Content_Types].xml");
  });

  it("writes every XML part well formed", () => {
    for (const [name, text] of files) if (name.endsWith(".xml") || name.endsWith(".rels")) expect(() => parseXml(text), name).not.toThrow();
  });

  it("gives every part a content type, and names only parts that exist", () => {
    const types = parseXml(files.get("[Content_Types].xml")!);
    const defaults = new Map(all(types, "Default").map((d) => [d.getAttribute("Extension")!, d.getAttribute("ContentType")!]));
    const overrides = new Map(all(types, "Override").map((o) => [o.getAttribute("PartName")!, o.getAttribute("ContentType")!]));
    expect(defaults.get("rels")).toBe("application/vnd.openxmlformats-package.relationships+xml");
    expect(defaults.get("xml")).toBe("application/xml");
    expect(defaults.get("png")).toBe("image/png");
    expect(defaults.get("jpeg")).toBe("image/jpeg");
    for (const part of overrides.keys()) expect(files.has(part.slice(1)), part).toBe(true);
    for (const name of files.keys()) {
      if (name === "[Content_Types].xml") continue;
      const type = overrides.get(`/${name}`) ?? defaults.get(name.split(".").pop()!);
      expect(type, name).toBeDefined();
    }
    const pml = "application/vnd.openxmlformats-officedocument.presentationml";
    expect(overrides.get("/ppt/presentation.xml")).toBe(`${pml}.presentation.main+xml`);
    expect(overrides.get("/ppt/slides/slide1.xml")).toBe(`${pml}.slide+xml`);
    expect(overrides.get("/ppt/slides/slide2.xml")).toBe(`${pml}.slide+xml`);
    expect(overrides.get("/ppt/slideMasters/slideMaster1.xml")).toBe(`${pml}.slideMaster+xml`);
    expect(overrides.get("/ppt/slideLayouts/slideLayout1.xml")).toBe(`${pml}.slideLayout+xml`);
    expect(overrides.get("/ppt/theme/theme1.xml")).toBe("application/vnd.openxmlformats-officedocument.theme+xml");
    expect(overrides.get("/docProps/core.xml")).toBe("application/vnd.openxmlformats-package.core-properties+xml");
    expect(overrides.get("/docProps/app.xml")).toBe("application/vnd.openxmlformats-officedocument.extended-properties+xml");
  });

  it("points every relationship at a part that exists, with ids unique per part", () => {
    for (const [name, text] of files) {
      if (!name.endsWith(".rels")) continue;
      const rels = all(parseXml(text), "Relationship");
      const ids = rels.map((r) => r.getAttribute("Id"));
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const r of rels) expect(files.has(resolveTarget(name, r.getAttribute("Target")!)), `${name} → ${r.getAttribute("Target")}`).toBe(true);
    }
    const root = all(parseXml(files.get("_rels/.rels")!), "Relationship").map((r) => [r.getAttribute("Type"), r.getAttribute("Target")]);
    expect(root).toContainEqual([`${REL_TYPE}officeDocument`, "ppt/presentation.xml"]);
  });

  it("lists the slides in order with ids from 256, the master, and the slide size", () => {
    const pres = parseXml(files.get("ppt/presentation.xml")!);
    const rels = new Map(all(parseXml(files.get("ppt/_rels/presentation.xml.rels")!), "Relationship").map((r) => [r.getAttribute("Id"), r]));
    const slideIds = all(pres, "p:sldId");
    expect(slideIds.map((s) => Number(s.getAttribute("id")))).toEqual([256, 257]);
    expect(slideIds.map((s) => rels.get(s.getAttribute("r:id"))!.getAttribute("Target"))).toEqual(["slides/slide1.xml", "slides/slide2.xml"]);
    expect(slideIds.map((s) => rels.get(s.getAttribute("r:id"))!.getAttribute("Type"))).toEqual([`${REL_TYPE}slide`, `${REL_TYPE}slide`]);
    const master = one(pres, "p:sldMasterId");
    expect(Number(master.getAttribute("id"))).toBeGreaterThanOrEqual(2147483648);
    expect(rels.get(master.getAttribute("r:id"))!.getAttribute("Target")).toBe("slideMasters/slideMaster1.xml");
    const size = one(pres, "p:sldSz");
    expect([size.getAttribute("cx"), size.getAttribute("cy")]).toEqual(["6480000", "3600000"]);
    expect(one(pres, "p:notesSz").getAttribute("cx")).toBeTruthy();
    // The element order the schema requires.
    const order = Array.from(pres.documentElement.children).map((c) => c.tagName);
    expect(order.indexOf("p:sldMasterIdLst")).toBeLessThan(order.indexOf("p:sldIdLst"));
    expect(order.indexOf("p:sldIdLst")).toBeLessThan(order.indexOf("p:sldSz"));
    expect(order.indexOf("p:sldSz")).toBeLessThan(order.indexOf("p:notesSz"));
  });

  it("writes each slide's body into its shape tree, its background, and its layout and media relationships", () => {
    const slide1 = parseXml(files.get("ppt/slides/slide1.xml")!);
    const tree = one(slide1, "p:spTree");
    expect(one(tree, "p:sp").getElementsByTagName("p:cNvPr")[0].getAttribute("name")).toBe("box");
    expect(one(one(slide1, "p:bg"), "a:srgbClr").getAttribute("val")).toBe("FAFAFA");
    expect(all(parseXml(files.get("ppt/slides/slide2.xml")!), "p:bg")).toHaveLength(0);

    const rels1 = all(parseXml(files.get("ppt/slides/_rels/slide1.xml.rels")!), "Relationship");
    expect(rels1.map((r) => [r.getAttribute("Id"), r.getAttribute("Type"), r.getAttribute("Target")])).toEqual([
      ["rId1", `${REL_TYPE}slideLayout`, "../slideLayouts/slideLayout1.xml"],
      [slideMediaRId(0), `${REL_TYPE}image`, "../media/image1.png"],
    ]);
    const rels2 = all(parseXml(files.get("ppt/slides/_rels/slide2.xml.rels")!), "Relationship");
    expect(rels2.map((r) => [r.getAttribute("Id"), r.getAttribute("Target")])).toEqual([
      ["rId1", "../slideLayouts/slideLayout1.xml"],
      [slideMediaRId(0), "../media/image1-2.png"],
      [slideMediaRId(1), "../media/photo.jpeg"],
    ]);
    expect(slideMediaRId(0)).toBe("rId2");
  });

  it("stores the media as given, uncompressed", () => {
    const entries = new Map(unzip(buildPptx(input())).map((e) => [e.name, e]));
    expect(entries.get("ppt/media/photo.jpeg")!.method).toBe(0);
    expect(entries.get("ppt/media/photo.jpeg")!.data).toEqual(JPEG);
    expect(entries.get("ppt/media/image1.png")!.data).toEqual(PNG);
  });

  it("writes a master with a colour map and text styles, a blank layout, and a whole theme", () => {
    const master = parseXml(files.get("ppt/slideMasters/slideMaster1.xml")!);
    const clrMap = one(master, "p:clrMap");
    for (const attr of ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"])
      expect(clrMap.getAttribute(attr), attr).toBeTruthy();
    for (const style of ["p:titleStyle", "p:bodyStyle", "p:otherStyle"]) one(one(master, "p:txStyles"), style);
    const layoutId = one(master, "p:sldLayoutId");
    expect(Number(layoutId.getAttribute("id"))).toBeGreaterThan(2147483648);
    const masterRels = all(parseXml(files.get("ppt/slideMasters/_rels/slideMaster1.xml.rels")!), "Relationship");
    expect(masterRels.find((r) => r.getAttribute("Id") === layoutId.getAttribute("r:id"))!.getAttribute("Type")).toBe(`${REL_TYPE}slideLayout`);
    expect(masterRels.some((r) => r.getAttribute("Type") === `${REL_TYPE}theme`)).toBe(true);

    const layout = parseXml(files.get("ppt/slideLayouts/slideLayout1.xml")!);
    expect(layout.documentElement.getAttribute("type")).toBe("blank");
    const layoutRels = all(parseXml(files.get("ppt/slideLayouts/_rels/slideLayout1.xml.rels")!), "Relationship");
    expect(layoutRels.map((r) => r.getAttribute("Type"))).toEqual([`${REL_TYPE}slideMaster`]);

    const theme = parseXml(files.get("ppt/theme/theme1.xml")!);
    expect(one(theme, "a:clrScheme").children).toHaveLength(12);
    one(one(theme, "a:fontScheme"), "a:majorFont");
    one(one(theme, "a:fontScheme"), "a:minorFont");
    expect(one(theme, "a:fillStyleLst").children).toHaveLength(3);
    expect(one(theme, "a:lnStyleLst").children).toHaveLength(3);
    expect(one(theme, "a:effectStyleLst").children).toHaveLength(3);
    expect(one(theme, "a:bgFillStyleLst").children).toHaveLength(3);
  });

  it("escapes the title and writes the creation time and slide count", () => {
    const core = parseXml(files.get("docProps/core.xml")!);
    expect(one(core, "dc:title").textContent).toBe('Fig <1> & "2"');
    expect(one(core, "dcterms:created").textContent).toBe("2026-11-10T12:00:00Z");
    expect(one(core, "dcterms:created").getAttribute("xsi:type")).toBe("dcterms:W3CDTF");
    expect(one(parseXml(files.get("docProps/app.xml")!), "Slides").textContent).toBe("2");
  });

  it("refuses a slide size PowerPoint cannot open, and no slides", () => {
    expect(() => buildPptx(input({ sizeEmu: { cx: 914399, cy: 3600000 } }))).toThrow(/size/);
    expect(() => buildPptx(input({ sizeEmu: { cx: 6480000, cy: 51206401 } }))).toThrow(/size/);
    expect(() => buildPptx(input({ sizeEmu: { cx: 6480000.5, cy: 3600000 } }))).toThrow(/size/);
    expect(() => buildPptx(input({ slides: [] }))).toThrow(/slide/);
  });

  it("refuses a background that is not a #rrggbb colour", () => {
    expect(() => buildPptx(input({ slides: [{ xml: "", background: "red", media: [] }] }))).toThrow(/background/);
  });
});
