import { createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";

// `obsidian` ships only typings, so this module cannot be loaded for real; the parts under test never touch it.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));
const { fileNodeType, fileNodeSvg } = await import("../../src/nodes/file-node");
const { fileNodeSvg: pureFileNodeSvg } = await import("../../src/nodes/file-node-svg");

const node = (over: Partial<FileNode> = {}): FileNode => ({
  ...fileNodeDefaults(createPage("a4-portrait", []), { file: "a.png", subpath: "", show: "image" }, []),
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  ...over,
});

test("the type is registered as 'file', named, with the image icon", () => {
  expect([fileNodeType.type, fileNodeType.name, fileNodeType.icon]).toEqual(["file", "Linked file", "image"]);
});

test("bounds are the node's rectangle", () => expect(fileNodeType.bounds(node())).toEqual({ x: 10, y: 20, width: 100, height: 50 }));

test("the inspector offers a Page field for pdf and tiff targets only", () => {
  const page = [{ kind: "number", key: "pageIndex", label: "Page", min: 0, step: 1 }];
  expect(fileNodeType.inspector(node({ file: "plot.pdf" }))).toEqual(page);
  expect(fileNodeType.inspector(node({ file: "figs/cells.TIF" }))).toEqual(page);
  expect(fileNodeType.inspector(node({ file: "cells.tiff" }))).toEqual(page);
  expect(fileNodeType.inspector(node({ file: "plot.png" }))).toEqual([]);
  expect(fileNodeType.inspector(node({ file: "analysis", subpath: "#Figure 2" }))).toEqual([]);
  expect(fileNodeType.inspector(node({ file: "v1.2/analysis" }))).toEqual([]);
});

test("file-node re-exports the pure SVG function", () => expect(fileNodeSvg).toBe(pureFileNodeSvg));

describe("toSvg", () => {
  const ctx = (assets: Map<string, any>) => ({ page: createPage("a4-portrait", []), assets, defs: [] as string[], warnings: [] as string[], uid: (p: string) => p + "-1" });

  test("reads the node's file asset from the asset map", () => {
    const n = node();
    const c = ctx(new Map([[n.id, { kind: "image", dataUri: "data:,x", naturalWidth: 100, naturalHeight: 50 }]]));
    expect(fileNodeType.toSvg(n, c)).toContain('<image href="data:,x"');
  });

  test("a rasterised asset is not the node type's own: the node counts as unresolved", () => {
    const n = node();
    const c = ctx(new Map([[n.id, { kind: "raster", dataUri: "data:,r" }]]));
    expect(fileNodeType.toSvg(n, c)).toBe("raster");
    expect(c.warnings[0]).toMatch(/missing/);
  });

  test("a content node asks for rasterising without a warning", () => {
    const c = ctx(new Map());
    expect(fileNodeType.toSvg(node({ show: "content" }), c)).toBe("raster");
    expect(c.warnings).toEqual([]);
  });
});
