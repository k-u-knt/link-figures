import { connectorNodeDefaults, createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import type { ConnectorNode, Document } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import type { PptxPart } from "../../src/registry/node-type";
import { pptxContext } from "../export/pptx/context";
import { all, one, parseFragment } from "../export/pptx/ooxml";

const E = 9525;

function connector(doc: Document, over: Partial<ConnectorNode> = {}): ConnectorNode {
  return { ...connectorNodeDefaults(doc.pages[0], { ends: [{ kind: "free", x: 10, y: 100 }, { kind: "free", x: 110, y: 50 }] }, []), id: "c1", ...over };
}

async function write(over: Partial<ConnectorNode> = {}, extra: (d: Document) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  extra(doc);
  const node = connector(doc, over);
  doc.nodes.push(node);
  const made = pptxContext({}, doc);
  const part = (await connectorNodeType.toPptx!(node, made.ctx)) as PptxPart;
  return { el: one(parseFragment(part.xml), "p:cxnSp"), warnings: made.warnings };
}

const points = (el: Element) => all(el, "a:pt").map((p) => [Number(p.getAttribute("x")), Number(p.getAttribute("y"))]);

describe("connector toPptx", () => {
  it("writes a connector shape whose geometry is the whole line, end to end, in its box", async () => {
    const { el } = await write();
    expect(one(el, "p:cNvPr").getAttribute("name")).toBe("c1");
    const xfrm = one(el, "a:xfrm");
    expect([one(xfrm, "a:off").getAttribute("x"), one(xfrm, "a:off").getAttribute("y")]).toEqual([String(10 * E), String(50 * E)]);
    expect([one(xfrm, "a:ext").getAttribute("cx"), one(xfrm, "a:ext").getAttribute("cy")]).toEqual([String(100 * E), String(50 * E)]);
    const path = one(el, "a:path");
    expect(path.getAttribute("fill")).toBe("none");
    expect(path.getAttribute("w")).toBe(String(100 * E));
    // Not shortened for the arrowhead: the line reaches the end, where PowerPoint draws the tail end.
    expect(points(el)).toEqual([
      [0, 50 * E],
      [100 * E, 0],
    ]);
    expect(Array.from(one(el, "p:spPr").children).map((c) => c.tagName)).toEqual(["a:xfrm", "a:custGeom", "a:noFill", "a:ln"]);
  });

  it("writes the caps as line ends, sized from the cap's size", async () => {
    const { el } = await write({ caps: [{ kind: "circle", size: 2 }, { kind: "arrow", size: 3 }] });
    const ln = one(el, "a:ln");
    expect(Array.from(ln.children).map((c) => c.tagName).slice(-2)).toEqual(["a:headEnd", "a:tailEnd"]);
    expect([one(ln, "a:headEnd").getAttribute("type"), one(ln, "a:headEnd").getAttribute("w")]).toEqual(["oval", "sm"]);
    expect([one(ln, "a:tailEnd").getAttribute("type"), one(ln, "a:tailEnd").getAttribute("len")]).toEqual(["triangle", "med"]);
    const open = await write({ caps: [{ kind: "none", size: 3 }, { kind: "openArrow", size: 6 }] });
    expect(one(open.el, "a:headEnd").getAttribute("type")).toBe("none");
    expect([one(open.el, "a:tailEnd").getAttribute("type"), one(open.el, "a:tailEnd").getAttribute("w")]).toEqual(["arrow", "lg"]);
    expect(open.warnings).toEqual([]);
  });

  it("writes a bar cap, or one not registered, as no line end, with a warning", async () => {
    const { el, warnings } = await write({ caps: [{ kind: "bar", size: 3 }, { kind: "fishtail", size: 3 }] });
    expect(one(el, "a:headEnd").getAttribute("type")).toBe("none");
    expect(one(el, "a:tailEnd").getAttribute("type")).toBe("none");
    expect(warnings).toEqual(['"c1" (Page 1): the "Bar" cap has no PowerPoint line end, written without one', '"c1" (Page 1): no cap kind "fishtail" is registered, written without it']);
  });

  it("strokes the line with its paint, a gradient laid over the route, and its width and opacity", async () => {
    const linear = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
    const { el } = await write({ stroke: { paint: linear, width: 2, dash: "dash" }, opacity: 0.5 });
    const ln = one(el, "a:ln");
    expect(ln.getAttribute("w")).toBe("25400");
    expect(one(ln, "a:gradFill")).toBeTruthy();
    expect(all(ln, "a:alpha").map((a) => a.getAttribute("val"))).toEqual(["50000", "50000"]);
    expect(one(ln, "a:prstDash").getAttribute("val")).toBe("dash");
  });

  it("writes a curved route as cubic curves", async () => {
    const { el } = await write({ route: "curved", routeParams: { bend: 0.3 } });
    expect(all(el, "a:cubicBezTo").length).toBeGreaterThan(0);
  });

  it("follows the items its ends are attached to", async () => {
    const { el } = await write(
      { ends: [{ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, { kind: "free", x: 200, y: 40 }], caps: [{ kind: "none", size: 3 }, { kind: "none", size: 3 }] },
      (doc) => doc.nodes.push({ ...shapeNodeDefaults(doc.pages[0], {}, []), id: "a", x: 0, y: 0, width: 100, height: 80 }),
    );
    // The east anchor of a 100 × 80 box at the origin is (100, 40).
    expect(one(one(el, "a:xfrm"), "a:off").getAttribute("x")).toBe(String(100 * E));
    expect(points(el)[0][0]).toBe(0);
  });
});
