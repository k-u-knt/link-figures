import { PATTERN_WARNING } from "../../src/export/pptx/drawingml";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import type { ShapeNode } from "../../src/model/types";
import { shapeNodeType } from "../../src/nodes/shape-node";
import type { PptxContext, PptxPart } from "../../src/registry/node-type";
import { pptxContext } from "../export/pptx/context";
import { all, one, parseFragment } from "../export/pptx/ooxml";

const doc = createDocument("a4-portrait");
const shape = (over: Partial<ShapeNode> = {}): ShapeNode => ({
  ...shapeNodeDefaults(doc.pages[0], { fill: { type: "solid", color: "#ff0000" } }, []),
  id: "s1",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  ...over,
});

async function write(node: ShapeNode, over: Partial<PptxContext> = {}) {
  const made = pptxContext(over, { ...doc, nodes: [node] });
  const part = await shapeNodeType.toPptx!(node, made.ctx);
  return { part, ...made };
}

async function sp(node: ShapeNode, over: Partial<PptxContext> = {}) {
  const { part, warnings } = await write(node, over);
  expect(typeof part).toBe("object");
  return { el: one(parseFragment((part as PptxPart).xml), "p:sp"), warnings };
}

describe("shape toPptx", () => {
  it("writes a rectangle as a preset rect at its box, filled and bordered", async () => {
    const { el } = await sp(shape());
    const spPr = one(el, "p:spPr");
    expect(Array.from(spPr.children).map((c) => c.tagName)).toEqual(["a:xfrm", "a:prstGeom", "a:solidFill", "a:ln"]);
    expect(one(spPr, "a:off").getAttribute("x")).toBe(String(10 * 9525));
    expect(one(spPr, "a:off").getAttribute("y")).toBe(String(20 * 9525));
    expect(one(spPr, "a:ext").getAttribute("cx")).toBe(String(100 * 9525));
    expect(one(spPr, "a:ext").getAttribute("cy")).toBe(String(50 * 9525));
    expect(one(spPr, "a:prstGeom").getAttribute("prst")).toBe("rect");
    expect(one(spPr.children[2], "a:srgbClr").getAttribute("val")).toBe("FF0000");
    // The default border: 1 pt solid black.
    const ln = one(spPr, "a:ln");
    expect(ln.getAttribute("w")).toBe("12700");
    expect(one(one(ln, "a:solidFill"), "a:srgbClr").getAttribute("val")).toBe("000000");
  });

  it("names the shape after the node, else its id, with a fresh id", async () => {
    const { el } = await sp(shape());
    expect(one(el, "p:cNvPr").getAttribute("name")).toBe("s1");
    expect(Number(one(el, "p:cNvPr").getAttribute("id"))).toBeGreaterThan(1);
    const named = await sp(shape({ name: "Box <A>" }));
    expect(one(named.el, "p:cNvPr").getAttribute("name")).toBe("Box <A>");
  });

  it("rounds corners with roundRect's adjust value, at most half the short side", async () => {
    const rounded = await sp(shape({ params: { cornerRadius: 10 } }));
    expect(one(rounded.el, "a:prstGeom").getAttribute("prst")).toBe("roundRect");
    expect(one(rounded.el, "a:gd").getAttribute("name")).toBe("adj");
    expect(one(rounded.el, "a:gd").getAttribute("fmla")).toBe("val 20000");
    const capped = await sp(shape({ params: { cornerRadius: 40 } }));
    expect(one(capped.el, "a:gd").getAttribute("fmla")).toBe("val 50000");
  });

  it("writes an ellipse as a preset ellipse", async () => {
    const { el } = await sp(shape({ kind: "ellipse", params: {} }));
    expect(one(el, "a:prstGeom").getAttribute("prst")).toBe("ellipse");
  });

  it("turns the shape with the node and fades every colour with its opacity", async () => {
    const { el } = await sp(shape({ rotation: 15, opacity: 0.5 }));
    expect(one(el, "a:xfrm").getAttribute("rot")).toBe("900000");
    const alphas = all(el, "a:alpha").map((a) => a.getAttribute("val"));
    expect(alphas).toEqual(["50000", "50000"]);
  });

  it("writes no border as a line with no fill", async () => {
    const { el } = await sp(shape({ border: null }));
    expect(one(one(el, "a:ln"), "a:noFill")).toBeTruthy();
  });

  it("scales the box with the slide", async () => {
    const { el } = await sp(shape(), { scale: 0.5, px: (v) => Math.round(v * 9525 * 0.5) });
    expect(one(el, "a:off").getAttribute("x")).toBe(String(5 * 9525));
    expect(one(el, "a:ext").getAttribute("cx")).toBe(String(50 * 9525));
  });

  it("warns with the shape's label, except the export-wide pattern warning", async () => {
    const { warnings } = await sp(shape({ fill: { type: "pattern", pattern: "dots", fg: "#000000", bg: null }, border: { paint: { type: "plaid" }, width: 1, dash: "solid" } }));
    expect(warnings).toContain(PATTERN_WARNING);
    expect(warnings.some((w) => w.startsWith('"s1" (Page 1)') && w.includes("plaid"))).toBe(true);
  });

  it("has a kind without PowerPoint geometry (or none registered) rasterised", async () => {
    expect((await write(shape({ kind: "star" }))).part).toBe("raster");
    const made = pptxContext({}, doc);
    made.ctx.registries.shapes.register({ id: "blob", name: "Blob", icon: "", defaults: () => ({}), fields: () => [], outline: () => [], anchors: () => [] });
    expect(await shapeNodeType.toPptx!(shape({ kind: "blob" }), made.ctx)).toBe("raster");
  });

  it("writes a kind's own geometry", async () => {
    const made = pptxContext({}, doc);
    made.ctx.registries.shapes.register({ id: "tri", name: "Triangle", icon: "", defaults: () => ({}), fields: () => [], outline: () => [], anchors: () => [], toPptx: () => '<a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>' });
    const part = (await shapeNodeType.toPptx!(shape({ kind: "tri" }), made.ctx)) as PptxPart;
    expect(one(parseFragment(part.xml), "a:prstGeom").getAttribute("prst")).toBe("triangle");
  });
});
