import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { fileNodeSvg } from "../../src/nodes/file-node-svg";

const page = createPage("a4-portrait", []);
const ctx = () => ({
  doc: { ...createDocument("a4-portrait"), pages: [page] },
  page,
  assets: new Map(),
  defs: [] as string[],
  warnings: [] as string[],
  uid: (p: string) => p + "-1",
});
const node = (over: Partial<FileNode> = {}): FileNode => ({
  ...fileNodeDefaults(page, { file: "a.png", subpath: "", show: "image" }, []),
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
  // Natural 200x100, right half (100x100) covered into 100x50: scale 1, so the crop is 100x100 at y -25 in the box, cut to it by the clip.
  expect(out).toMatch(new RegExp(`^<g clip-path="url\\(#clip-1\\)"><svg x="10" y="-5" width="100" height="100" viewBox="100 0 100 100" preserveAspectRatio="xMidYMid meet" id="${n.id}-root">`));
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
  expect(out).toMatch(/^<g clip-path="url\(#clip-1\)"><svg x="10" y="20" width="100" height="50" viewBox="10 20 200 100" preserveAspectRatio="xMidYMid meet" id="p-[a-z0-9]{4}-root">/);
});

test("svg asset keeps the namespace prefixes its root declared, so inlined xlink:href stays well-formed", () => {
  const n = node({ file: "plot.svg" });
  const out = fileNodeSvg(
    n,
    { kind: "svg", text: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use xlink:href="#a"/></svg>', width: 10, height: 10 },
    ctx(),
  ) as string;
  expect(out).toMatch(new RegExp(`^<g clip-path="url\\(#clip-1\\)"><svg x="10" y="-5" width="100" height="100" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet" id="${n.id}-root" xmlns:xlink="http:\\/\\/www\\.w3\\.org\\/1999\\/xlink">`));
});

const svglite =
  "<svg xmlns='http://www.w3.org/2000/svg' class='svglite' width='72.00pt' height='72.00pt' viewBox='0 0 72.00 72.00'>" +
  "<defs><style type='text/css'><![CDATA[.svglite polyline { fill: none; stroke: #000000; }]]></style></defs>" +
  "<rect width='100%' height='100%' style='stroke: none; fill: #FFFFFF;'/><polyline points='1,1 2,2' class='line'/></svg>";

test("svg asset: the root's class and scoped rules go with the panel, so an svglite line plot is not filled", () => {
  const n = node({ file: "plot.svg" });
  const out = fileNodeSvg(n, { kind: "svg", text: svglite, width: 96, height: 96 }, ctx()) as string;
  // The nested element is the root: same id the rules are scoped to, and the class they select on.
  expect(out).toContain(`id="${n.id}-root" class="${n.id}-svglite">`);
  expect(out).toContain(`#${n.id}-root.${n.id}-svglite polyline{ fill: none; stroke: #000000; }`);
  expect(out).toContain(`<polyline points='1,1 2,2' class='${n.id}-line'/>`);
  expect(out).not.toMatch(/[^-]\.svglite|class='svglite'/);
});

test("svg asset: two panels that use the same class names do not restyle each other", () => {
  const a = node({ file: "a.svg" });
  const b = node({ file: "b.svg" });
  const file = (colour: string) => `<svg viewBox="0 0 10 10"><style>.st0{fill:${colour}}</style><rect class="st0"/></svg>`;
  const c = ctx();
  const outA = fileNodeSvg(a, { kind: "svg", text: file("red"), width: 10, height: 10 }, c) as string;
  const outB = fileNodeSvg(b, { kind: "svg", text: file("blue"), width: 10, height: 10 }, c) as string;
  expect(outA).toContain(`#${a.id}-root .${a.id}-st0{fill:red}`);
  expect(outA).toContain(`<rect class="${a.id}-st0"/>`);
  expect(outB).toContain(`#${b.id}-root .${b.id}-st0{fill:blue}`);
  expect(outA + outB).not.toMatch(/[^-]\.st0/);
});

test("svg asset: an entity-declaring DOCTYPE does not leave undeclared references, and scripts are gone", () => {
  const text =
    '<!DOCTYPE svg [<!ENTITY ns_x "http://ns.adobe.com/Extensibility/1.0/">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:x="&ns_x;" viewBox="0 0 10 10" onload="evil()"><script>evil()</script><g x:foo="1"/></svg>';
  const out = fileNodeSvg(node({ file: "ai.svg" }), { kind: "svg", text, width: 10, height: 10 }, ctx()) as string;
  expect(out).toContain(' xmlns:x="http://ns.adobe.com/Extensibility/1.0/"');
  expect(out).not.toMatch(/&ns_x;|<script|onload|DOCTYPE/);
});

test("svg asset: what inlining had to drop is warned about, naming the panel", () => {
  const c = ctx();
  const n = node({ file: "plot.svg" });
  fileNodeSvg(n, { kind: "svg", text: '<svg viewBox="0 0 1 1"><style>@media print{.a{x:y}}</style></svg>', width: 1, height: 1 }, c);
  expect(c.warnings).toEqual([`Panel "plot.svg" (${page.name}): @media rule in <style> dropped`]);
});

test("svg asset: references out of the file, on its root or inside it, are dropped and warned about once each, naming the panel", () => {
  const c = ctx();
  const n = node({ file: "plot.svg" });
  const text = '<svg viewBox="0 0 1 1" style="background:url(http://t/x.png)"><image href="http://t/x.png"/><svg:script>evil()</svg:script></svg>';
  const out = fileNodeSvg(n, { kind: "svg", text, width: 1, height: 1 }, c) as string;
  expect(out).not.toMatch(/http:|script/);
  expect(c.warnings).toEqual([`Panel "plot.svg" (${page.name}): external reference removed: http://t/x.png`]);
});

test("ids from uid are used for every clip path in one build", () => {
  let n = 0;
  const c = { ...ctx(), uid: (p: string) => `${p}-${++n}` };
  const asset = { kind: "image" as const, dataUri: "data:,x", naturalWidth: 1, naturalHeight: 1 };
  fileNodeSvg(node(), asset, c);
  fileNodeSvg(node(), asset, c);
  expect(c.defs.map((d) => /id="([^"]+)"/.exec(d)![1])).toEqual(["clip-1", "clip-2"]);
});

// A crop is clipped to the crop region, not to the node's box: with `contain` the rest of the image must not fill the letterbox.

test("image: the clip is the crop's region in the box (offset by the node), not the node's rectangle", () => {
  const c = ctx();
  // Natural 200x100, right half (100x100), contained in 100x50: scale 0.5, so the crop is 50x50, centred (x 25) in the box.
  // The whole image is then 100x50, 50 to the left of the crop's own left edge: at x -25 in the box.
  const out = fileNodeSvg(node({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: "contain" }), { kind: "image", dataUri: "data:,x", naturalWidth: 200, naturalHeight: 100 }, c) as string;
  expect(c.defs[0]).toBe('<clipPath id="clip-1"><rect x="35" y="20" width="50" height="50"/></clipPath>');
  expect(out).toContain('x="-15" y="20" width="100" height="50"');
});

describe("svg asset with the right-half crop of a 100x100 viewBox on a 200x100 node at (10, 20)", () => {
  const asset = { kind: "svg" as const, text: '<svg viewBox="0 0 100 100"><rect/></svg>', width: 100, height: 100 };
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };

  test("contain: the crop's part of the viewBox fills a viewport of the crop's aspect, letterboxed in the node and clipped to it", () => {
    const c = ctx();
    const n = node({ file: "plot.svg", width: 200, height: 100, crop, fit: "contain" });
    const out = fileNodeSvg(n, asset, c) as string;
    expect(out).toMatch(new RegExp(`^<g clip-path="url\\(#clip-1\\)"><svg x="85" y="20" width="50" height="100" viewBox="50 0 50 100" preserveAspectRatio="xMidYMid meet" id="${n.id}-root">`));
    expect(out).toMatch(/<\/svg><\/g>$/);
    expect(c.defs).toEqual(['<clipPath id="clip-1"><rect x="85" y="20" width="50" height="100"/></clipPath>']);
  });

  test("cover: the viewport is scaled up past the node, which clips it", () => {
    const c = ctx();
    const n = node({ file: "plot.svg", width: 200, height: 100, crop, fit: "cover" });
    const out = fileNodeSvg(n, asset, c) as string;
    expect(out).toMatch(new RegExp(`^<g clip-path="url\\(#clip-1\\)"><svg x="10" y="-130" width="200" height="400" viewBox="50 0 50 100" preserveAspectRatio="xMidYMid meet" id="${n.id}-root">`));
    expect(c.defs).toEqual(['<clipPath id="clip-1"><rect x="10" y="20" width="200" height="100"/></clipPath>']);
  });
});

test("an image asset's own crop (after trimming) is used instead of the node's", () => {
  // The node's crop is the right half; the asset is that half alone, so its crop is all of it.
  const n = node({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const out = fileNodeSvg(n, { kind: "image", dataUri: "data:,x", naturalWidth: 100, naturalHeight: 100, crop: { x: 0, y: 0, w: 1, h: 1 } }, ctx()) as string;
  // The uncut 200×100 image is drawn at x -90; its right half starts 100 further on.
  expect(out).toContain('x="10" y="-5" width="100" height="100"');
});

test("a PDF asset's raster crop (after trimming) is used for its raster instead of the node's crop", () => {
  const n = node({ file: "plot.pdf", crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const out = fileNodeSvg(
    n,
    {
      kind: "pdf",
      bytes: new ArrayBuffer(0),
      pageIndex: 0,
      widthPt: 300,
      heightPt: 150,
      raster: "data:,cut",
      rasterWidth: 100,
      rasterHeight: 100,
      rasterCrop: { x: 0, y: 0, w: 1, h: 1 },
    },
    ctx(),
  ) as string;
  expect(out).toContain('href="data:,cut" x="10" y="-5" width="100" height="100"');
});
