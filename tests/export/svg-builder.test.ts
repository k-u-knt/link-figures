import { nodeLabel } from "../../src/model/labels";
import type { AssetMap, FileAsset } from "../../src/export/asset-types";
import { buildPageSvg, escapeAttr } from "../../src/export/svg-builder";
import { MM_TO_PX } from "../../src/constants";
import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { NodeTypeRegistry } from "../../src/registry/node-type";

// The file node type imports the real Obsidian API for its DOM; this suite only builds strings.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const reg = () => {
  const r = new NodeTypeRegistry();
  r.register(fileNodeType);
  return r;
};
const docWith = (over: Partial<FileNode>) => {
  const d = createDocument("nature-double");
  d.nodes.push({
    ...fileNodeDefaults(d.pages[0], { file: "a.png", subpath: "", show: "image" }, []),
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    ...over,
  });
  return d;
};

test("page svg has mm size and px viewBox", () => {
  const d = docWith({});
  const { svg } = buildPageSvg(d, d.pages[0], reg(), new Map());
  expect(svg).toContain('width="183mm" height="170mm"');
  expect(svg).toContain(`viewBox="0 0 ${183 * MM_TO_PX} ${170 * MM_TO_PX}"`);
  expect(svg).toContain('fill="#ffffff"');
});

test("image node is embedded and clipped", () => {
  const d = docWith({});
  const id = d.nodes[0].id;
  const { svg, warnings } = buildPageSvg(
    d,
    d.pages[0],
    reg(),
    new Map([[id, { kind: "image", dataUri: "data:image/png;base64,QQ==", naturalWidth: 200, naturalHeight: 100 }]]),
  );
  expect(svg).toContain("<clipPath");
  expect(svg).toContain('href="data:image/png;base64,QQ=="');
  expect(warnings).toEqual([]);
  expect(svg).not.toContain("foreignObject");
});

test("raster asset becomes an <image> with a warning", () => {
  const d = docWith({ show: "content" });
  const id = d.nodes[0].id;
  const { svg, warnings } = buildPageSvg(d, d.pages[0], reg(), new Map([[id, { kind: "raster", dataUri: "data:image/png;base64,QQ==" }]]));
  expect(svg).toContain('<image href="data:image/png;base64,QQ=="');
  expect(warnings[0]).toMatch(/rasterised/);
});

test("rotation and opacity wrap in a group", () => {
  const d = docWith({ rotation: 90, opacity: 0.5 });
  const id = d.nodes[0].id;
  const { svg } = buildPageSvg(
    d,
    d.pages[0],
    reg(),
    new Map([[id, { kind: "image", dataUri: "data:,x", naturalWidth: 1, naturalHeight: 1 }]]),
  );
  expect(svg).toContain('<g opacity="0.5" transform="rotate(90 60 45)">');
});

test("nodes on other pages are excluded", () => {
  const d = docWith({});
  d.pages.push(createPage("a4-portrait", [d.pages[0].id]));
  const { svg } = buildPageSvg(d, d.pages[1], reg(), new Map());
  expect(svg).not.toContain("<image");
});

test("only + paper:false builds a transparent layer of chosen nodes", () => {
  const d = docWith({});
  const id = d.nodes[0].id;
  const assets: AssetMap = new Map([[id, { kind: "image", dataUri: "data:,x", naturalWidth: 1, naturalHeight: 1 }]]);
  expect(buildPageSvg(d, d.pages[0], reg(), assets, { only: new Set(), paper: false }).svg).not.toMatch(/<rect|<image/);
  expect(buildPageSvg(d, d.pages[0], reg(), assets, { only: new Set([id]), paper: false }).svg).toContain("<image");
});

test("escapeAttr", () => expect(escapeAttr('a"<&')).toBe("a&quot;&lt;&amp;"));

// Beyond the brief's seven.

const image = (): FileAsset => ({ kind: "image", dataUri: "data:,x", naturalWidth: 100, naturalHeight: 50 });

test("only opacity or only rotation wraps with just that attribute; an unrotated opaque node has no group", () => {
  const withOpacity = docWith({ opacity: 0.25 });
  const withRotation = docWith({ rotation: 45 });
  const plain = docWith({});
  const build = (d: ReturnType<typeof docWith>) => buildPageSvg(d, d.pages[0], reg(), new Map([[d.nodes[0].id, image()]])).svg;
  expect(build(withOpacity)).toContain('<g opacity="0.25">');
  expect(build(withOpacity)).not.toContain("transform=");
  expect(build(withRotation)).toContain('<g transform="rotate(45 60 45)">');
  expect(build(withRotation)).not.toContain("opacity=");
  expect(build(plain)).not.toContain("<g");
});

test("a rasterised node is wrapped like any other, and placed at the node's own rectangle", () => {
  const d = docWith({ show: "content", rotation: 30 });
  const id = d.nodes[0].id;
  const { svg } = buildPageSvg(d, d.pages[0], reg(), new Map([[id, { kind: "raster", dataUri: "data:,r" }]]));
  expect(svg).toContain('<g transform="rotate(30 60 45)"><image href="data:,r" x="10" y="20" width="100" height="50" preserveAspectRatio="none"/></g>');
});

test("a raster node without a raster asset is skipped with a warning", () => {
  const d = docWith({ show: "content" });
  const { svg, warnings } = buildPageSvg(d, d.pages[0], reg(), new Map());
  expect(svg).not.toContain("<image");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(nodeLabel(d, d.nodes[0]));
});

test("a missing link is reported once, not once by the node type and again by the builder", () => {
  const d = docWith({});
  const { warnings } = buildPageSvg(d, d.pages[0], reg(), new Map());
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/link missing/);
});

test("a node whose type is not registered is skipped with a warning", () => {
  const d = docWith({});
  const { svg, warnings } = buildPageSvg(d, d.pages[0], new NodeTypeRegistry(), new Map([[d.nodes[0].id, image()]]));
  expect(svg).not.toContain("<image");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('"file"');
});

test("nodes are drawn in z order, equal z keeping document order", () => {
  const d = docWith({ z: 2, file: "top.png" });
  const page = d.pages[0];
  d.nodes.push({ ...fileNodeDefaults(page, { file: "b.png", subpath: "", show: "image" }, d.nodes.map((n) => n.id)), z: 1 });
  d.nodes.push({ ...fileNodeDefaults(page, { file: "c.png", subpath: "", show: "image" }, d.nodes.map((n) => n.id)), z: 1 });
  const assets: AssetMap = new Map(d.nodes.map((n, i) => [n.id, { kind: "image", dataUri: `data:,n${i}`, naturalWidth: 1, naturalHeight: 1 }]));
  const { svg } = buildPageSvg(d, page, reg(), assets);
  const order = [...svg.matchAll(/href="data:,n(\d)"/g)].map((m) => m[1]);
  expect(order).toEqual(["1", "2", "0"]);
});

test("clip ids are unique within a build and restart in the next", () => {
  const d = docWith({});
  d.nodes.push({ ...fileNodeDefaults(d.pages[0], { file: "b.png", subpath: "", show: "image" }, [d.nodes[0].id]), x: 0, y: 0 });
  const assets: AssetMap = new Map(d.nodes.map((n) => [n.id, image()]));
  const first = buildPageSvg(d, d.pages[0], reg(), assets).svg;
  expect(first).toContain('<clipPath id="clip-1">');
  expect(first).toContain('<clipPath id="clip-2">');
  expect(first).toContain('clip-path="url(#clip-1)"');
  expect(first).toContain('clip-path="url(#clip-2)"');
  expect(buildPageSvg(d, d.pages[0], reg(), assets).svg).toBe(first);
});

test("defs come before the paper and the nodes; an empty page is just the sheet", () => {
  const d = docWith({});
  const { svg } = buildPageSvg(d, d.pages[0], reg(), new Map([[d.nodes[0].id, image()]]));
  expect(svg.indexOf("<defs>")).toBeGreaterThan(-1);
  expect(svg.indexOf("<defs>")).toBeLessThan(svg.indexOf("<rect width"));
  expect(svg.indexOf("<rect width")).toBeLessThan(svg.indexOf("<image"));

  const empty = createDocument("a4-portrait");
  const out = buildPageSvg(empty, empty.pages[0], reg(), new Map());
  expect(out.warnings).toEqual([]);
  expect(out.svg).toMatch(/^<svg [^>]*width="210mm" height="297mm"[^>]*>\n<rect [^>]*\/>\n<\/svg>$/);
});

test("the page's paper colour and every embedded value are escaped as attributes", () => {
  const d = docWith({});
  d.pages[0].paper = 'a"b<c&d';
  const out = buildPageSvg(d, d.pages[0], reg(), new Map([[d.nodes[0].id, { kind: "raster", dataUri: 'x"y' }]]));
  expect(out.svg).toContain('fill="a&quot;b&lt;c&amp;d"');
  const raster = docWith({ show: "content" });
  const svg = buildPageSvg(raster, raster.pages[0], reg(), new Map([[raster.nodes[0].id, { kind: "raster", dataUri: 'x"y<' }]])).svg;
  expect(svg).toContain('href="x&quot;y&lt;"');
});

test("the output has no foreignObject, class, filter or mask", () => {
  const d = docWith({ rotation: 10, opacity: 0.9 });
  const svg = buildPageSvg(d, d.pages[0], reg(), new Map([[d.nodes[0].id, image()]])).svg;
  expect(svg).not.toMatch(/foreignObject|class=|<filter|<mask/);
});
