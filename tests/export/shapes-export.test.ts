import { PT_TO_PX } from "../../src/constants";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import type { AssetMap } from "../../src/export/asset-types";
import { buildPageSvg } from "../../src/export/svg-builder";
import { toSvgPath } from "../../src/model/path";
import type { ConnectorNode } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { fileNodeType } from "../../src/nodes/file-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { connector, docWith, panel, panelAssets, shape, STOPS } from "./shapes-fixtures";

// The file node type imports the real Obsidian API for its DOM; this suite only builds strings.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

function registries() {
  const r = createRegistries();
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(fileNodeType);
  return r;
}

describe("SVG export", () => {
  test("a shape with a gradient fill and a dashed border", () => {
    const d = docWith(shape);
    const { svg, warnings } = buildPageSvg(d, d.pages[0], registries(), new Map());
    const w = 0.75 * PT_TO_PX;
    expect(svg).toContain(`<defs><linearGradient id="grad-1" gradientUnits="userSpaceOnUse" x1="10" y1="45" x2="110" y2="45">${STOPS}</linearGradient></defs>`);
    expect(svg).toContain(
      `<path d="M10 20 L110 20 L110 70 L10 70 Z" fill="url(#grad-1)" stroke="#000000" stroke-width="${w}" stroke-dasharray="${4 * w} ${2 * w}"/>`,
    );
    expect(warnings).toEqual([]);
  });

  test("a connector with a gradient stroke and an arrow cap filled with the same gradient", () => {
    const d = docWith(connector);
    const r = registries();
    const { svg, warnings } = buildPageSvg(d, d.pages[0], r, new Map());
    const resolved = resolveConnector(d, d.nodes[0] as ConnectorNode, r);
    const box = resolved.paintBox;
    const cy = box.y + box.height / 2;
    expect(svg).toContain(
      `<linearGradient id="grad-1" gradientUnits="userSpaceOnUse" x1="${box.x}" y1="${cy}" x2="${box.x + box.width}" y2="${cy}">${STOPS}</linearGradient>`,
    );
    expect(svg).toContain(
      `<path d="${toSvgPath(resolved.path)}" fill="none" stroke="url(#grad-1)" stroke-width="${1.5 * PT_TO_PX}"/>` +
        `<path d="${toSvgPath(resolved.caps[1]!)}" fill="url(#grad-1)"/>`,
    );
    expect(warnings).toEqual([]);
  });

  test("a file panel's frame is drawn over its picture, on the node's box, with a pattern laid out in that box", () => {
    const d = docWith(panel);
    const { svg, warnings } = buildPageSvg(d, d.pages[0], registries(), panelAssets());
    expect(svg).toContain(
      `<pattern id="pattern-1" patternUnits="userSpaceOnUse" x="20" y="130" width="8" height="8"><path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6" fill="none" stroke="#123456" stroke-width="1"/></pattern>`,
    );
    expect(svg).toMatch(/<\/svg><\/g><path d="M20 130 L100 130 L100 190 L20 190 Z" fill="none" stroke="url\(#pattern-1\)" stroke-width="4"\/>/);
    expect(warnings).toEqual([]);
  });

  test("a frame is drawn over a panel the DOM rasterised too, and a panel without a frame draws none", () => {
    const d = docWith((doc) => ({ ...panel(doc), show: "content" }));
    const assets: AssetMap = new Map([["f", { kind: "raster", dataUri: "data:image/png;base64,AA" }]]);
    const { svg } = buildPageSvg(d, d.pages[0], registries(), assets);
    expect(svg).toMatch(/preserveAspectRatio="none"\/><path d="M20 130 L100 130 L100 190 L20 190 Z" fill="none" stroke="url\(#pattern-1\)"/);
    const bare = docWith((doc) => ({ ...panel(doc), frame: null }));
    expect(buildPageSvg(bare, bare.pages[0], registries(), panelAssets()).svg).not.toContain("<path");
  });
});

