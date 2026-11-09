import type { AssetMap } from "../../src/export/asset-types";
import { dataUriBytes } from "../../src/export/pptx/media";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode, Stroke } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import type { PptxPart } from "../../src/registry/node-type";
import { PNG_BYTES, pptxContext } from "../export/pptx/context";
import { all, one, parseFragment } from "../export/pptx/ooxml";

const E = 9525;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const PNG_URI = `data:image/png;base64,${b64(PNG_BYTES)}`;
const JPEG_URI = `data:image/jpeg;base64,${b64(JPEG)}`;
const frame: Stroke = { paint: { type: "solid", color: "#ff0000" }, width: 1, dash: "solid" };

function panel(over: Partial<FileNode> = {}): FileNode {
  const doc = createDocument("a4-portrait");
  return { ...fileNodeDefaults(doc.pages[0], { file: "Plots/plot.png", subpath: "", show: "image" }, []), id: "f1", x: 100, y: 50, width: 200, height: 100, ...over };
}

async function write(node: FileNode, assets: AssetMap) {
  const doc = createDocument("a4-portrait");
  node = { ...node, page: doc.pages[0].id };
  doc.nodes.push(node);
  const made = pptxContext({ assets }, doc);
  const part = (await fileNodeType.toPptx!(node, made.ctx)) as PptxPart | null;
  return { part, doc: part ? parseFragment(part.xml) : null, ...made };
}

const xfrmOf = (el: Element) => {
  const x = one(el, "a:xfrm");
  return [one(x, "a:off").getAttribute("x"), one(x, "a:off").getAttribute("y"), one(x, "a:ext").getAttribute("cx"), one(x, "a:ext").getAttribute("cy")].map(Number);
};

describe("file panel toPptx", () => {
  it("embeds a PNG's own bytes as a picture of the box, named and described by its link", async () => {
    const { doc, media, warnings } = await write(panel({ subpath: "#^fig" }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 400, naturalHeight: 200 }]]));
    const pic = one(doc!, "p:pic");
    expect(one(pic, "p:cNvPr").getAttribute("name")).toBe("f1");
    expect(one(pic, "p:cNvPr").getAttribute("descr")).toBe("[[Plots/plot.png#^fig]]");
    // r:embed must survive parsing (happy-dom keeps it: no other `embed` attribute).
    expect(one(pic, "a:blip").getAttribute("r:embed")).toBe("rId2");
    expect(media).toEqual([{ bytes: PNG_BYTES, ext: "png" }]);
    expect(xfrmOf(pic)).toEqual([100 * E, 50 * E, 200 * E, 100 * E]);
    expect(all(pic, "a:srcRect")).toHaveLength(0);
    expect(warnings).toEqual([]);
  });

  it("cuts a cropped or covering image with srcRect, never negative", async () => {
    // A 400 × 400 image covering a 200 × 100 box: scaled to 200 × 200, 50 px cut off top and bottom.
    const cover = await write(panel(), new Map([["f1", { kind: "image", dataUri: JPEG_URI, naturalWidth: 400, naturalHeight: 400 }]]));
    const src = one(cover.doc!, "a:srcRect");
    expect([src.getAttribute("l"), src.getAttribute("t"), src.getAttribute("r"), src.getAttribute("b")]).toEqual(["0", "25000", "0", "25000"]);
    expect(cover.media[0].ext).toBe("jpeg");
    // A crop's left half: the picture shows that half, cut 50 % on the right.
    const crop = await write(panel({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 400, naturalHeight: 100 }]]));
    const s2 = one(crop.doc!, "a:srcRect");
    expect([s2.getAttribute("l"), s2.getAttribute("r")]).toEqual(["0", "50000"]);
    // A trimmed asset's crop reaching outside the image: the picture shrinks to the image instead of a negative srcRect.
    const out = await write(panel({ fit: "contain" }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 100, naturalHeight: 100, crop: { x: -0.5, y: 0, w: 2, h: 1 } }]]));
    // The 100 px image sits at 50-150 of the box's 200 px; that is all that shows, uncut.
    expect(all(out.doc!, "a:srcRect")).toHaveLength(0);
    expect(xfrmOf(one(out.doc!, "p:pic"))).toEqual([150 * E, 50 * E, 100 * E, 100 * E]);
  });

  it("puts a contained image where it shows, with the frame as a rectangle of its own", async () => {
    const { doc } = await write(panel({ fit: "contain", frame }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 100, naturalHeight: 100 }]]));
    const pic = one(doc!, "p:pic");
    // 100 × 100 contained in 200 × 100: centred, 50 px in from the left.
    expect(xfrmOf(pic)).toEqual([150 * E, 50 * E, 100 * E, 100 * E]);
    expect(all(pic, "a:ln")).toHaveLength(0);
    const sp = one(doc!, "p:sp");
    expect(xfrmOf(sp)).toEqual([100 * E, 50 * E, 200 * E, 100 * E]);
    expect(one(sp, "a:ln").getAttribute("w")).toBe("12700");
    expect(one(sp, "p:cNvPr").getAttribute("name")).toBe("f1 frame");
  });

  it("puts the frame on the picture when it fills the box, and turns and fades both with the node", async () => {
    const { doc } = await write(panel({ frame, rotation: 90, opacity: 0.25 }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 200, naturalHeight: 100 }]]));
    const pic = one(doc!, "p:pic");
    expect(one(one(pic, "p:spPr"), "a:ln")).toBeTruthy();
    expect(one(pic, "a:xfrm").getAttribute("rot")).toBe("5400000");
    expect(one(pic, "a:alphaModFix").getAttribute("amt")).toBe("25000");
  });

  it("turns a part of the box about the box's centre", async () => {
    const { doc } = await write(panel({ fit: "contain", rotation: 180 }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 50, naturalHeight: 100 }]]));
    // 50 × 100 contained in the 200 × 100 box sits at x 175-225 in page px; turned half about (200, 100), still 175-225.
    expect(xfrmOf(one(doc!, "p:pic"))).toEqual([175 * E, 50 * E, 50 * E, 100 * E]);
    const off = await write(panel({ fit: "contain", rotation: 180, width: 300 }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 50, naturalHeight: 100 }]]));
    // Box 100-400, centre 250; the picture 225-275 stays centred.
    expect(xfrmOf(one(off.doc!, "p:pic"))[0]).toBe(225 * E);
  });

  it("draws an image PowerPoint does not take as a PNG, with a warning", async () => {
    const gif = `data:image/gif;base64,${b64(new Uint8Array([0x47, 0x49, 0x46]))}`;
    const { doc, media, rasterised, warnings } = await write(panel(), new Map([["f1", { kind: "image", dataUri: gif, naturalWidth: 200, naturalHeight: 100 }]]));
    expect(media[0]).toEqual({ bytes: PNG_BYTES, ext: "png" });
    expect(rasterised[0].fragment).toContain(`href="${gif}"`);
    expect(rasterised[0].box).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(all(doc!, "a:srcRect")).toHaveLength(0);
    expect(warnings[0]).toContain("image/gif");
  });

  it("writes a PDF panel's raster and a TIFF panel's PNG, cut as images, each with a warning", async () => {
    const pdf = await write(panel({ file: "a.pdf" }), new Map([["f1", { kind: "pdf", bytes: new ArrayBuffer(0), pageIndex: 0, widthPt: 1, heightPt: 1, raster: PNG_URI, rasterWidth: 200, rasterHeight: 200 }]]));
    expect(one(pdf.doc!, "a:srcRect").getAttribute("t")).toBe("25000");
    expect(pdf.warnings).toEqual(['"f1" (Page 1): PDF panel written as a picture']);
    const tiff = await write(panel({ file: "scan.tif" }), new Map([["f1", { kind: "image", dataUri: PNG_URI, naturalWidth: 200, naturalHeight: 100 }]]));
    expect(tiff.warnings).toEqual(['"f1" (Page 1): TIFF panel written as PNG']);
  });

  it("draws an SVG panel over its box, with its clip, as a picture with a warning", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>';
    const { doc, rasterised, warnings } = await write(panel({ file: "p.svg" }), new Map([["f1", { kind: "svg", text: svg, width: 10, height: 10 }]]));
    expect(rasterised[0].box).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(rasterised[0].fragment).toMatch(/^<defs><clipPath id="[^"]+">/);
    expect(rasterised[0].fragment).toContain('fill="#00ff00"');
    expect(one(doc!, "p:pic")).toBeTruthy();
    expect(warnings).toEqual(['"f1" (Page 1): SVG panel written as a picture']);
  });

  it("writes a content card's snapshot over its box, with a warning", async () => {
    const { doc, media, warnings } = await write(panel({ show: "content", file: "note.md" }), new Map([["f1", { kind: "raster", dataUri: PNG_URI }]]));
    expect(xfrmOf(one(doc!, "p:pic"))).toEqual([100 * E, 50 * E, 200 * E, 100 * E]);
    expect(media).toHaveLength(1);
    expect(warnings).toEqual(['"f1" (Page 1): content card written as a picture']);
  });

  it("leaves out a panel with nothing to draw, saying why", async () => {
    const missing = await write(panel(), new Map());
    expect(missing.part).toBeNull();
    expect(missing.warnings).toEqual(['"f1" (Page 1): link missing, skipped']);
    const skipped = await write(panel(), new Map([["f1", { kind: "skipped", reason: "heading or block not found" }]]));
    expect(skipped.part).toBeNull();
    expect(skipped.warnings).toEqual(['"f1" (Page 1): heading or block not found, skipped']);
  });

  it("leaves out a panel whose picture cannot be drawn, saying why", async () => {
    const doc = createDocument("a4-portrait");
    const node = { ...panel({ file: "p.svg" }), page: doc.pages[0].id };
    const made = pptxContext({ assets: new Map([["f1", { kind: "svg", text: "<svg/>", width: 1, height: 1 }]]), rasterise: async () => Promise.reject(new Error("no canvas")) }, doc);
    expect(await fileNodeType.toPptx!(node, made.ctx)).toBeNull();
    expect(made.warnings.at(-1)).toContain("could not be written: no canvas");
  });
});

describe("dataUriBytes", () => {
  it("reads base64 and URL-encoded data URIs", () => {
    expect(dataUriBytes(PNG_URI)).toEqual({ mime: "image/png", bytes: PNG_BYTES });
    expect(dataUriBytes("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")).toEqual({ mime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") });
    expect(dataUriBytes("http://x")).toBeNull();
  });
});
