import { DEFAULT_FONT } from "../../src/constants";
import { BASELINE_DROP } from "../../src/nodes/text-node-pptx";
import { createDocument, textNodeDefaults } from "../../src/model/defaults";
import type { TextNode } from "../../src/model/types";
import { textNodeType } from "../../src/nodes/text-node";
import type { PptxContext, PptxPart } from "../../src/registry/node-type";
import { pptxContext } from "../export/pptx/context";
import { all, one, parseFragment } from "../export/pptx/ooxml";

const doc = createDocument("a4-portrait");
const text = (over: Partial<TextNode> = {}): TextNode => ({ ...textNodeDefaults(doc.pages[0], {}, []), id: "t1", x: 10, y: 20, width: 100, height: 40, text: "A\nTop", ...over });

async function sp(node: TextNode, over: Partial<PptxContext> = {}) {
  const { ctx } = pptxContext(over, { ...doc, nodes: [node] });
  const part = (await textNodeType.toPptx!(node, ctx)) as PptxPart;
  return one(parseFragment(part.xml), "p:sp");
}

describe("text toPptx", () => {
  it("writes a text box at the label's box, with no fill or line", async () => {
    const el = await sp(text());
    expect(one(el, "p:cNvSpPr").getAttribute("txBox")).toBe("1");
    expect(one(el, "p:cNvPr").getAttribute("name")).toBe("t1");
    expect(one(el, "a:off").getAttribute("x")).toBe(String(10 * 9525));
    expect(one(el, "a:ext").getAttribute("cy")).toBe(String(40 * 9525));
    const spPr = one(el, "p:spPr");
    expect(Array.from(spPr.children).map((c) => c.tagName)).toEqual(["a:xfrm", "a:prstGeom", "a:noFill", "a:ln"]);
  });

  it("sets the body unwrapped, without autofit or side insets", async () => {
    const body = one(await sp(text()), "a:bodyPr");
    expect(body.getAttribute("wrap")).toBe("none");
    expect(body.getAttribute("anchor")).toBe("t");
    for (const inset of ["lIns", "rIns", "bIns"]) expect(body.getAttribute(inset), inset).toBe("0");
    expect(one(body, "a:noAutofit")).toBeTruthy();
  });

  // PowerPoint-style layout puts a line's baseline BASELINE_DROP sizes above the bottom of its line box:
  // first baseline = tIns + first spacing − 0.2 × size, which should be one size.
  const firstBaselinePt = (el: Element, sizePt: number) =>
    Number(one(el, "a:bodyPr").getAttribute("tIns")) / 12700 + Number(all(el, "a:spcPts")[0].getAttribute("val")) / 100 - BASELINE_DROP * sizePt;

  it("puts the first baseline a font size below the top with the top inset, the line height 1.2 or less", async () => {
    for (const lineHeight of [0.8, 1, 1.2]) {
      const el = await sp(text({ font: { ...DEFAULT_FONT, size: 20, lineHeight } }));
      expect(firstBaselinePt(el, 20), String(lineHeight)).toBeCloseTo(20, 1);
      const spacings = all(el, "a:lnSpc").map((l) => one(l, "a:spcPts").getAttribute("val"));
      expect(spacings).toEqual([String(Math.round(lineHeight * 2000)), String(Math.round(lineHeight * 2000))]);
    }
    expect(one(await sp(text({ font: { ...DEFAULT_FONT, size: 20, lineHeight: 1.2 } })), "a:bodyPr").getAttribute("tIns")).toBe("0");
  });

  it("puts it there with a shorter first line, the line height above 1.2 (no negative inset)", async () => {
    const el = await sp(text({ font: { ...DEFAULT_FONT, size: 20, lineHeight: 2 } }));
    expect(one(el, "a:bodyPr").getAttribute("tIns")).toBe("0");
    expect(firstBaselinePt(el, 20)).toBeCloseTo(20, 1);
    const spacings = all(el, "a:lnSpc").map((l) => one(l, "a:spcPts").getAttribute("val"));
    expect(spacings).toEqual(["2400", "4000"]);
  });

  it("writes one paragraph per line, each a run in the label's font, with exact line spacing", async () => {
    const el = await sp(text({ font: { ...DEFAULT_FONT, family: "Georgia", size: 9, weight: "bold", italic: true, color: "#336699", align: "center", lineHeight: 1.5 } }));
    const paras = all(el, "a:p");
    expect(paras).toHaveLength(2);
    expect(paras.map((p) => one(p, "a:t").textContent)).toEqual(["A", "Top"]);
    expect(paras.map((p) => one(one(p, "a:lnSpc"), "a:spcPts").getAttribute("val"))).toEqual(["1080", "1350"]);
    for (const p of paras) {
      expect(one(p, "a:pPr").getAttribute("algn")).toBe("ctr");
      const rPr = one(p, "a:rPr");
      expect(rPr.getAttribute("sz")).toBe("900");
      expect(rPr.getAttribute("b")).toBe("1");
      expect(rPr.getAttribute("i")).toBe("1");
      expect(one(rPr, "a:latin").getAttribute("typeface")).toBe("Georgia");
      expect(one(one(rPr, "a:solidFill"), "a:srgbClr").getAttribute("val")).toBe("336699");
    }
  });

  it("aligns left and right", async () => {
    expect(all(await sp(text()), "a:pPr")[0].getAttribute("algn")).toBe("l");
    expect(all(await sp(text({ font: { ...DEFAULT_FONT, align: "right" } })), "a:pPr")[0].getAttribute("algn")).toBe("r");
  });

  it("keeps blank lines as empty paragraphs of the same size, and empty text as one", async () => {
    const el = await sp(text({ text: "a\n\n b" }));
    const paras = all(el, "a:p");
    expect(paras).toHaveLength(3);
    expect(all(paras[1], "a:r")).toHaveLength(0);
    expect(one(paras[1], "a:endParaRPr").getAttribute("sz")).toBe("700");
    expect(one(paras[2], "a:t").textContent).toBe(" b");
    expect(all(await sp(text({ text: "" })), "a:p")).toHaveLength(1);
  });

  it("clamps a size and spacing past PowerPoint's limits, with a warning", async () => {
    const { ctx, warnings } = pptxContext({}, { ...doc, nodes: [] });
    const big = parseFragment(((await textNodeType.toPptx!(text({ font: { ...DEFAULT_FONT, size: 5000, lineHeight: 2 } }), ctx)) as PptxPart).xml);
    expect(all(big, "a:rPr")[0].getAttribute("sz")).toBe("400000");
    expect(all(big, "a:spcPts").map((s) => s.getAttribute("val"))).toContain("158400");
    expect(warnings.some((w) => w.includes("font size"))).toBe(true);
    expect(warnings.some((w) => w.includes("line spacing"))).toBe(true);
    const small = parseFragment(((await textNodeType.toPptx!(text({ font: { ...DEFAULT_FONT, size: 0.5 } }), ctx)) as PptxPart).xml);
    expect(all(small, "a:rPr")[0].getAttribute("sz")).toBe("100");
  });

  it("escapes the text and splits on any line break", async () => {
    const el = await sp(text({ text: "x < y & z\r\n\"q\"\r'w'" }));
    expect(all(el, "a:t").map((t) => t.textContent)).toEqual(["x < y & z", '"q"', "'w'"]);
  });

  it("turns with the node, fades with its opacity, and scales with the slide", async () => {
    const el = await sp(text({ text: "one line", rotation: -90, opacity: 0.4 }), { scale: 0.5, px: (v) => Math.round(v * 9525 * 0.5) });
    expect(one(el, "a:xfrm").getAttribute("rot")).toBe("16200000");
    expect(one(one(el, "a:rPr"), "a:alpha").getAttribute("val")).toBe("40000");
    expect(one(el, "a:rPr").getAttribute("sz")).toBe("350");
    expect(one(one(el, "a:lnSpc"), "a:spcPts").getAttribute("val")).toBe(String(Math.round(7 * DEFAULT_FONT.lineHeight * 0.5 * 100)));
  });

});
