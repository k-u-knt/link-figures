import { PT_TO_PX } from "../constants";
import { escapeAttr } from "../export/svg-builder";
import type { TextNode } from "../model/types";
import type { SvgContext } from "../registry/node-type";

const ANCHOR = { left: "start", center: "middle", right: "end" } as const;

/**
 * What a blank line holds. A `<tspan>` with no characters in it is not placed, so its `dy` is lost and the lines after
 * it move up; a non-breaking space is a character, which is. (A line of only spaces collapses to nothing in SVG, so it is blank too.)
 */
const BLANK_LINE = "&#160;";

/** For text between tags. (A quote needs no escape there.) */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A text node as an SVG fragment, in the node's own (unrotated) coordinates: one `<text>` whose first baseline is a
 * font size below the top of the box, and one `<tspan>` per line of the text, each starting at the same `x` and a line
 * height below the one before. `x` is the box's left, centre or right edge, as the alignment says, with the anchor to
 * match. The text is written as it is: not wrapped to the box (only the lines the text itself has), and not clipped.
 * A blank line is a `<tspan>` holding a non-breaking space.
 * Numbers are written as they are, unrounded.
 */
export function textNodeSvg(node: TextNode, _ctx: SvgContext): string {
  const { font } = node;
  const sizePx = font.size * PT_TO_PX;
  const x = font.align === "center" ? node.x + node.width / 2 : font.align === "right" ? node.x + node.width : node.x;

  const attrs = [
    `x="${x}"`,
    `y="${node.y + sizePx}"`,
    `font-family="${escapeAttr(font.family)}"`,
    `font-size="${sizePx}"`,
  ];
  if (font.weight === "bold") attrs.push('font-weight="bold"');
  if (font.italic) attrs.push('font-style="italic"');
  attrs.push(`fill="${escapeAttr(font.color)}"`, `text-anchor="${ANCHOR[font.align]}"`);

  const lines = node.text === "" ? [] : node.text.split(/\r\n|\r|\n/);
  const spans = lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : font.lineHeight * sizePx}">${line.trim() === "" ? BLANK_LINE : escapeText(line)}</tspan>`);
  return `<text ${attrs.join(" ")}>${spans.join("")}</text>`;
}
