import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import type { Paint, ShapeNode } from "../../src/model/types";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { builtinRampGeometries, paintOfRamp, rampOf } from "../../src/paint/ramp";
import { createRegistries } from "../../src/registry";

/** One paint of each kind, as a figure written by 0.3.0 has them (key order included). */
const PAINTS: Paint[] = [
  { type: "none" },
  { type: "solid", color: "#ff0000" },
  { type: "solid", color: "#00ff00", opacity: 0.5 },
  { type: "linear", angle: 30, stops: [{ offset: 0, color: "#000000" }, { offset: 0.4, color: "#ff0000", opacity: 0.25 }, { offset: 1, color: "#ffffff" }] },
  { type: "radial", cx: 0.25, cy: 0.75, r: 0.6, stops: [{ offset: 0, color: "#0000ff" }, { offset: 1, color: "#00ff00", opacity: 0 }] },
  { type: "pattern", pattern: "hatch", fg: "#000000", bg: null, scale: 1, angle: 0 },
  { type: "x.future", amount: 3 },
];

/** A figure with one shape per paint, as its file text. */
function figureText(): string {
  const doc = createDocument("a4-portrait");
  for (const fill of PAINTS) doc.nodes.push({ ...shapeNodeDefaults(doc.pages[0], {}, doc.nodes.map((n) => n.id)), fill: structuredClone(fill) } as ShapeNode);
  return serializeFigureFile(doc, emptyParsed());
}

describe("figures with each paint type", () => {
  test("load and save byte-identically", () => {
    const text = figureText();
    const { doc, parsed } = loadDocument(text);
    expect(serializeFigureFile(doc, parsed)).toBe(text);
    expect(doc.nodes.map((n) => (n as ShapeNode).fill)).toEqual(PAINTS);
  });

  test("a ramp paint read by the colour slider and written back unchanged saves byte-identically", () => {
    const registries = createRegistries();
    for (const t of builtinPaintTypes) registries.paints.register(t);
    for (const g of builtinRampGeometries) registries.rampGeometries.register(g);
    const text = figureText();
    const { doc, parsed } = loadDocument(text);
    for (const node of doc.nodes as ShapeNode[]) {
      const ramp = rampOf(node.fill, registries);
      if (ramp) node.fill = paintOfRamp(ramp, node.fill, registries.rampGeometries);
    }
    expect(serializeFigureFile(doc, parsed)).toBe(text);
  });
});
