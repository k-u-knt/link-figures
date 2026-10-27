import { createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { fileNodeSvg } from "../../src/nodes/file-node-svg";

const ctx = () => ({
  page: createPage("a4-portrait", []),
  assets: new Map(),
  defs: [] as string[],
  warnings: [] as string[],
  uid: (p: string) => p + "-1",
});
const node = (over: Partial<FileNode> = {}): FileNode => ({
  ...fileNodeDefaults(createPage("a4-portrait", []), { file: "a.png", subpath: "", show: "image" }, []),
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  ...over,
});

test("image node becomes a clipped <image>", () => {
  const c = ctx();
  const out = fileNodeSvg(node(), { kind: "image", dataUri: "data:image/png;base64,AAAA", naturalWidth: 200, naturalHeight: 100 }, c);
  expect(out).toContain('href="data:image/png;base64,AAAA"');
  expect(out).toContain('clip-path="url(#clip-1)"');
  expect(c.defs[0]).toContain('<clipPath id="clip-1"><rect x="10" y="20" width="100" height="50"/></clipPath>');
  expect(out).toContain('x="10" y="20" width="100" height="50"');
});

test("content node is raster", () => {
  expect(fileNodeSvg(node({ show: "content" }), undefined, ctx())).toBe("raster");
});

test("missing asset is raster with a warning", () => {
  const c = ctx();
  expect(fileNodeSvg(node(), undefined, c)).toBe("raster");
  expect(c.warnings[0]).toMatch(/missing/);
});

test("svg asset is inlined with namespaced ids and the crop as viewBox", () => {
  const c = ctx();
  const n = node({ file: "plot.svg", crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const out = fileNodeSvg(
    n,
    { kind: "svg", text: '<svg viewBox="0 0 200 100"><defs><clipPath id="c1"><rect/></clipPath></defs><rect clip-path="url(#c1)"/></svg>', width: 200, height: 100 },
    c,
  ) as string;
  expect(out).toMatch(/^<svg x="10" y="20" width="100" height="50" viewBox="100 0 100 100" preserveAspectRatio="xMidYMid slice">/);
  expect(out).toContain(`id="${n.id}-c1"`);
  expect(out).toContain(`url(#${n.id}-c1)`);
  expect(c.warnings).toEqual([]);
});

test("pdf asset is raster image with a warning", () => {
  const c = ctx();
  const out = fileNodeSvg(
    node({ file: "plot.pdf" }),
    { kind: "pdf", bytes: new ArrayBuffer(0), pageIndex: 0, widthPt: 300, heightPt: 200, raster: "data:image/png;base64,QQ==", rasterWidth: 1250, rasterHeight: 833 },
    c,
  ) as string;
  expect(out).toContain('href="data:image/png;base64,QQ=="');
  expect(c.warnings[0]).toMatch(/PDF panel rasterised/);
});

// Beyond the brief's five.

test("image placement follows crop and fit: a cropped image is scaled and offset inside the clip", () => {
  const c = ctx();
  // Natural 200x100 cropped to its right half (100x100) and covered into a 100x50 box: scale 1, so the full image is 200x100,
  // shifted left by 100 so the crop starts at the box's left edge, and centred vertically (-25).
  const out = fileNodeSvg(node({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }), { kind: "image", dataUri: "data:,x", naturalWidth: 200, naturalHeight: 100 }, c) as string;
  expect(out).toContain('x="-90" y="-5" width="200" height="100"');
  expect(c.defs[0]).toContain('<rect x="10" y="20" width="100" height="50"/>');
});

test("contain places the whole image inside the box", () => {
  const out = fileNodeSvg(node({ fit: "contain" }), { kind: "image", dataUri: "data:,x", naturalWidth: 100, naturalHeight: 100 }, ctx()) as string;
  expect(out).toContain('x="35" y="20" width="50" height="50"');
});

test("pdf placement uses the raster size, not the page size in points", () => {
  const out = fileNodeSvg(
    node({ width: 100, height: 100, fit: "contain" }),
    { kind: "pdf", bytes: new ArrayBuffer(0), pageIndex: 0, widthPt: 10, heightPt: 10, raster: "data:,r", rasterWidth: 200, rasterHeight: 100 },
    ctx(),
  ) as string;
  expect(out).toContain('x="10" y="45" width="100" height="50"');
});

test("svg asset without a crop uses the whole viewBox, and contain means meet", () => {
  const out = fileNodeSvg(
    node({ file: "plot.svg", fit: "contain" }),
    { kind: "svg", text: '<svg viewBox="10 20 200 100"><rect/></svg>', width: 200, height: 100 },
    ctx(),
  ) as string;
  expect(out).toMatch(/^<svg x="10" y="20" width="100" height="50" viewBox="10 20 200 100" preserveAspectRatio="xMidYMid meet">/);
});

test("svg asset keeps the namespace prefixes its root declared, so inlined xlink:href stays well-formed", () => {
  const out = fileNodeSvg(
    node({ file: "plot.svg" }),
    { kind: "svg", text: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use xlink:href="#a"/></svg>', width: 10, height: 10 },
    ctx(),
  ) as string;
  expect(out).toMatch(/^<svg x="10" y="20" width="100" height="50" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice" xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink">/);
});

test("ids from uid are used for every clip path in one build", () => {
  let n = 0;
  const c = { ...ctx(), uid: (p: string) => `${p}-${++n}` };
  const asset = { kind: "image" as const, dataUri: "data:,x", naturalWidth: 1, naturalHeight: 1 };
  fileNodeSvg(node(), asset, c);
  fileNodeSvg(node(), asset, c);
  expect(c.defs.map((d) => /id="([^"]+)"/.exec(d)![1])).toEqual(["clip-1", "clip-2"]);
});
