import { PX_TO_PT } from "../../src/constants";
import { pdfPanelPlacement, splitLayers } from "../../src/export/pdf-layers";
import { createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode, Node } from "../../src/model/types";

const n = (id: string, z: number, pdf = false) => ({ id, z, type: "file", file: pdf ? "a.pdf" : "a.png" }) as any;
const isPdf = (node: Node) => (node as FileNode).file.endsWith(".pdf");

const page = createPage("a4-portrait", []);
const PAGE_HEIGHT_PT = (297 * 72) / 25.4;
/** A panel whose rectangle is given in pt, measured from the page's top-left corner, as the user sees it. */
const panel = (xPt: number, yPt: number, widthPt: number, heightPt: number, over: Partial<FileNode> = {}): FileNode => ({
  ...fileNodeDefaults(page, { file: "a.pdf", subpath: "", show: "image" }, []),
  x: xPt / PX_TO_PT,
  y: yPt / PX_TO_PT,
  width: widthPt / PX_TO_PT,
  height: heightPt / PX_TO_PT,
  ...over,
});

test("splitLayers groups runs around pdf panels in z order", () => {
  const layers = splitLayers([n("c", 2, true), n("a", 0), n("b", 1), n("d", 3)], isPdf);
  expect(layers).toEqual([{ kind: "svg", nodeIds: ["a", "b"] }, { kind: "pdf", nodeId: "c" }, { kind: "svg", nodeIds: ["d"] }]);
});

test("a leading pdf panel still gets an empty first svg layer", () => {
  expect(splitLayers([n("c", 0, true)], isPdf)[0]).toEqual({ kind: "svg", nodeIds: [] });
});

test("no pdf panel is one svg layer, and no nodes at all are one empty svg layer, so the paper has a home", () => {
  expect(splitLayers([n("b", 1), n("a", 0)], isPdf)).toEqual([{ kind: "svg", nodeIds: ["a", "b"] }]);
  expect(splitLayers([], isPdf)).toEqual([{ kind: "svg", nodeIds: [] }]);
});

test("adjacent pdf panels are layers of their own, with no empty svg layer between them", () => {
  const layers = splitLayers([n("a", 0, true), n("b", 1, true), n("c", 2)], isPdf);
  expect(layers).toEqual([{ kind: "svg", nodeIds: [] }, { kind: "pdf", nodeId: "a" }, { kind: "pdf", nodeId: "b" }, { kind: "svg", nodeIds: ["c"] }]);
});

test("nodes with the same z keep their order, as the SVG builder keeps them", () => {
  expect(splitLayers([n("a", 1), n("b", 1), n("c", 1)], isPdf)).toEqual([{ kind: "svg", nodeIds: ["a", "b", "c"] }]);
});

test("splitLayers does not reorder the list it was given", () => {
  const nodes = [n("b", 1), n("a", 0)];
  splitLayers(nodes, isPdf);
  expect(nodes.map((x) => x.id)).toEqual(["b", "a"]);
});

test("placement of an uncropped panel with matching aspect", () => {
  const node = { ...fileNodeDefaults(page, { file: "a.pdf", subpath: "", show: "image" }, []), x: 0, y: 0, width: 300 / PX_TO_PT, height: 200 / PX_TO_PT };
  const pl = pdfPanelPlacement(node, page, { widthPt: 300, heightPt: 200 });
  expect(pl.width).toBeCloseTo(300);
  expect(pl.height).toBeCloseTo(200);
  expect(pl.x).toBeCloseTo(0);
  expect(pl.y).toBeCloseTo((297 * 72) / 25.4 - 200);
  expect(pl.rotate).toBe(0);
  expect(pl.box).toEqual({ left: 0, bottom: 0, right: 300, top: 200 });
});

test("crop selects the right half of the source page", () => {
  const node = {
    ...fileNodeDefaults(page, { file: "a.pdf", subpath: "", show: "image" }, []),
    x: 0,
    y: 0,
    width: 150 / PX_TO_PT,
    height: 200 / PX_TO_PT,
    crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
  };
  expect(pdfPanelPlacement(node, page, { widthPt: 300, heightPt: 200 }).box).toEqual({ left: 150, bottom: 0, right: 300, top: 200 });
});

test("a crop measured from the top of the source is a box measured from its bottom", () => {
  // The top-left quarter of a 300 x 200 source: PDF's y axis points up, so that is the upper rows.
  const node = panel(0, 0, 150, 100, { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  expect(pdfPanelPlacement(node, page, { widthPt: 300, heightPt: 200 }).box).toEqual({ left: 0, bottom: 100, right: 150, top: 200 });
});

test("the panel's position is measured down from the page's top and up from the PDF's bottom", () => {
  const pl = pdfPanelPlacement(panel(40, 60, 300, 200), page, { widthPt: 300, heightPt: 200 });
  expect(pl.x).toBeCloseTo(40);
  expect(pl.y).toBeCloseTo(PAGE_HEIGHT_PT - 60 - 200);
});

test("cover fills the node and the source overflow is cut from the box, centred", () => {
  // A 100 x 100 source in a 300 x 200 node, scaled by 3: the node shows 100 x 66.67 of the source.
  const pl = pdfPanelPlacement(panel(30, 50, 300, 200, { fit: "cover" }), page, { widthPt: 100, heightPt: 100 });
  expect(pl.width).toBeCloseTo(300);
  expect(pl.height).toBeCloseTo(200);
  expect(pl.x).toBeCloseTo(30);
  expect(pl.y).toBeCloseTo(PAGE_HEIGHT_PT - 50 - 200);
  expect(pl.box.left).toBeCloseTo(0);
  expect(pl.box.right).toBeCloseTo(100);
  expect(pl.box.bottom).toBeCloseTo(100 / 6);
  expect(pl.box.top).toBeCloseTo(100 - 100 / 6);
});

test("contain draws all of the source inside the node, letterboxed and centred", () => {
  // The same 100 x 100 source in a 300 x 200 node: scaled by 2 to 200 x 200, with 50 left and right.
  const pl = pdfPanelPlacement(panel(30, 50, 300, 200, { fit: "contain" }), page, { widthPt: 100, heightPt: 100 });
  expect(pl.width).toBeCloseTo(200);
  expect(pl.height).toBeCloseTo(200);
  expect(pl.x).toBeCloseTo(80);
  expect(pl.y).toBeCloseTo(PAGE_HEIGHT_PT - 50 - 200);
  expect(pl.box).toEqual({ left: 0, bottom: 0, right: 100, top: 100 });
});

test("contain letterboxes a wide source above and below", () => {
  const pl = pdfPanelPlacement(panel(0, 0, 200, 300, { fit: "contain" }), page, { widthPt: 100, heightPt: 50 });
  expect(pl.width).toBeCloseTo(200);
  expect(pl.height).toBeCloseTo(100);
  expect(pl.x).toBeCloseTo(0);
  // The node's centre is 150 below the page's top; the 100-high source is centred on it.
  expect(pl.y).toBeCloseTo(PAGE_HEIGHT_PT - 150 - 50);
});

test("cover and contain work on the crop region, not on the whole source", () => {
  // The right half of a 300 x 200 source is 150 x 200: it already has the node's 3:4 aspect, so nothing is cut or boxed in.
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
  for (const fit of ["cover", "contain"] as const) {
    const pl = pdfPanelPlacement(panel(0, 0, 150, 200, { fit, crop }), page, { widthPt: 300, heightPt: 200 });
    expect(pl.box).toEqual({ left: 150, bottom: 0, right: 300, top: 200 });
    expect(pl.width).toBeCloseTo(150);
    expect(pl.height).toBeCloseTo(200);
  }
});

test("a rotation is the opposite way in PDF, and about the node's centre", () => {
  // A 300 x 200 node turned 90 degrees clockwise on screen. Its centre stays at (150, PAGE_HEIGHT_PT - 100).
  const pl = pdfPanelPlacement(panel(0, 0, 300, 200, { rotation: 90 }), page, { widthPt: 300, heightPt: 200 });
  expect(pl.rotate).toBe(-90);
  // pdf-lib turns a page about its own bottom-left corner. The anchor must be where that corner lands so the middle stays put.
  const angle = (pl.rotate * Math.PI) / 180;
  const centre = {
    x: pl.x + (pl.width / 2) * Math.cos(angle) - (pl.height / 2) * Math.sin(angle),
    y: pl.y + (pl.width / 2) * Math.sin(angle) + (pl.height / 2) * Math.cos(angle),
  };
  expect(centre.x).toBeCloseTo(150);
  expect(centre.y).toBeCloseTo(PAGE_HEIGHT_PT - 100);
  // Spelled out: the corner that was bottom-left ends up top-left of the turned node, above and to the right of the old one.
  expect(pl.x).toBeCloseTo(50);
  expect(pl.y).toBeCloseTo(PAGE_HEIGHT_PT + 50);
});

test("rotation and crop together: the box is the crop, the turn is about the node's centre", () => {
  const node = panel(100, 100, 150, 200, { rotation: 30, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const pl = pdfPanelPlacement(node, page, { widthPt: 300, heightPt: 200 });
  expect(pl.box).toEqual({ left: 150, bottom: 0, right: 300, top: 200 });
  expect(pl.rotate).toBe(-30);
  const angle = (pl.rotate * Math.PI) / 180;
  expect(pl.x + (pl.width / 2) * Math.cos(angle) - (pl.height / 2) * Math.sin(angle)).toBeCloseTo(100 + 75);
  expect(pl.y + (pl.width / 2) * Math.sin(angle) + (pl.height / 2) * Math.cos(angle)).toBeCloseTo(PAGE_HEIGHT_PT - 100 - 100);
});

test("a container (a group) draws nothing, so it opens no layer, even when its z sorts after a PDF panel", () => {
  const group = { id: "g", z: 1, type: "group" } as any;
  const nodes = [n("a", 0), { ...n("p", 1, true), parent: "g" }, { ...n("b", 0), parent: "g" }, group];
  const isContainer = (node: Node) => node.type === "group";
  expect(splitLayers(nodes, isPdf, isContainer)).toEqual([{ kind: "svg", nodeIds: ["a", "b"] }, { kind: "pdf", nodeId: "p" }]);
});
