import { PT_TO_PX } from "../constants";
import { clampWhole, colorXml, hexColor, labelled, MAX_FONT_SZ, MAX_SPC_PTS, MIN_FONT_SZ, nvPrXml, xfrmXml, xmlSafe } from "../export/pptx/drawingml";
import { escapeXml } from "../export/pptx/package";
import { nodeLabel } from "../model/labels";
import type { TextNode } from "../model/types";
import type { PptxContext, PptxPart } from "../registry/node-type";

/**
 * Where PowerPoint-style layout puts a line's baseline with exact line spacing: this far (in font sizes) above the bottom
 * of the line's box, whose height is the spacing, whatever the font. Measured in LibreOffice (which lays PPTX text out
 * as PowerPoint does): baseline = top inset + spacing − 0.2 × size, for Arial, Calibri, Georgia and Courier New alike.
 */
export const BASELINE_DROP = 0.2;

const ALIGN = { left: "l", center: "ctr", right: "r" } as const;


/**
 * A label as a text box (`p:sp txBox`) at its box, turned with the node: one paragraph per line of its text, each one
 * run in the label's font (family, size, weight, italic, colour faded by the node's opacity), aligned as the label is,
 * with exact line spacing (line height × size). The body is unwrapped, without autofit, with no side or bottom insets.
 * The first baseline is a font size below the box's top, as on the stage: with a line height up to 1 + BASELINE_DROP
 * by the top inset; above that (an inset would be negative) by giving the first line a spacing of 1 + BASELINE_DROP
 * sizes instead.
 */
export function textNodePptx(node: TextNode, base: PptxContext): PptxPart {
  const ctx = labelled(base, nodeLabel(base.doc, node));
  const { font } = node;
  const sizePt = font.size * ctx.scale;
  const sz = clampWhole(sizePt * 100, MIN_FONT_SZ, MAX_FONT_SZ, "the font size (1/100 pt)", ctx);
  const rgb = hexColor(font.color);
  if (rgb === null) ctx.warn(`the colour ${JSON.stringify(font.color)} is not one PowerPoint can take, written as black`);
  const typeface = escapeXml(xmlSafe(font.family));
  const rPrAttrs = `lang="en-US" sz="${sz}"${font.weight === "bold" ? ' b="1"' : ' b="0"'}${font.italic ? ' i="1"' : ' i="0"'} dirty="0"`;
  const rPrBody = `<a:solidFill>${colorXml(rgb ?? "000000", node.opacity)}</a:solidFill><a:latin typeface="${typeface}"/><a:ea typeface="${typeface}"/><a:cs typeface="${typeface}"/>`;
  // The first line's spacing and the top inset (in font sizes) that put its baseline a size below the top.
  const firstLine = 1 + BASELINE_DROP;
  const inset = Math.max(0, firstLine - font.lineHeight);
  const pPr = (lineHeight: number): string =>
    `<a:pPr algn="${ALIGN[font.align] ?? "l"}"><a:lnSpc><a:spcPts val="${clampWhole(lineHeight * sizePt * 100, 0, MAX_SPC_PTS, "the line spacing (1/100 pt)", ctx)}"/></a:lnSpc>` +
    '<a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr>';
  const end = `<a:endParaRPr ${rPrAttrs}>${rPrBody}</a:endParaRPr>`;

  const lines = node.text === "" ? [""] : node.text.split(/\r\n|\r|\n/);
  const paras = lines.map((line, i) => {
    const run = line === "" ? "" : `<a:r><a:rPr ${rPrAttrs}>${rPrBody}</a:rPr><a:t>${escapeXml(xmlSafe(line))}</a:t></a:r>`;
    return `<a:p>${pPr(i === 0 && inset === 0 ? firstLine : font.lineHeight)}${run}${end}</a:p>`;
  });

  const tIns = ctx.px(font.size * PT_TO_PX * inset);
  const bodyPr = `<a:bodyPr wrap="none" lIns="0" tIns="${tIns}" rIns="0" bIns="0" anchor="t" rtlCol="0"><a:noAutofit/></a:bodyPr>`;
  const xfrm = xfrmXml({ x: ctx.px(node.x), y: ctx.px(node.y), cx: ctx.px(node.width), cy: ctx.px(node.height) }, node.rotation);
  const nv = `<p:nvSpPr>${nvPrXml(ctx.nextId(), node.name ?? node.id)}<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`;
  const spPr = `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>`;
  return { xml: `<p:sp>${nv}${spPr}<p:txBody>${bodyPr}<a:lstStyle/>${paras.join("")}</p:txBody></p:sp>` };
}
