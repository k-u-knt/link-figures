import { connectorNodeDefaults, createDocument, fileNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import type { AssetMap } from "../../src/export/asset-types";
import type { Document, Node } from "../../src/model/types";

/** What the export tests of shapes, connectors and frames draw. */
export const STOPS = '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>';
export const linear = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
export const hatch = { type: "pattern", pattern: "hatch", fg: "#123456", bg: null, scale: 1, angle: 0 };

export const docWith = (...make: ((d: Document) => Node)[]): Document => {
  const d = createDocument("nature-double");
  for (const m of make) d.nodes.push(m(d));
  return d;
};
export const shape = (d: Document): Node => ({
  ...shapeNodeDefaults(d.pages[0], { fill: linear, border: { paint: { type: "solid", color: "#000000" }, width: 0.75, dash: "dash" } }, []),
  id: "s",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
});
export const connector = (d: Document): Node => ({
  ...connectorNodeDefaults(d.pages[0], { ends: [{ kind: "free", x: 10, y: 100 }, { kind: "free", x: 110, y: 100 }], stroke: { paint: linear, width: 1.5, dash: "solid" } }, []),
  id: "c",
});
export const SVG_PANEL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>';
export const panel = (d: Document): Node => ({
  ...fileNodeDefaults(d.pages[0], { file: "plot.svg", subpath: "", show: "image", frame: { paint: hatch, width: 3, dash: "solid" } }, []),
  id: "f",
  x: 20,
  y: 130,
  width: 80,
  height: 60,
});
export const panelAssets = (): AssetMap => new Map([["f", { kind: "svg", text: SVG_PANEL, width: 10, height: 10 }]]);

