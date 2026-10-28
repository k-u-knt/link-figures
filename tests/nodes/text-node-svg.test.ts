import { DEFAULT_FONT, PT_TO_PX } from "../../src/constants";
import { createDocument, createPage, textNodeDefaults } from "../../src/model/defaults";
import type { TextNode } from "../../src/model/types";
import { textNodeSvg } from "../../src/nodes/text-node-svg";

const page = createPage("a4-portrait", []);
const ctx = () => ({ doc: { ...createDocument("a4-portrait"), pages: [page] }, page, assets: new Map(), defs: [] as string[], warnings: [] as string[], uid: (p: string) => p + "-1" });
const node = (over: Partial<TextNode> = {}): TextNode => ({ ...textNodeDefaults(page, {}, []), x: 10, y: 20, width: 100, height: 40, ...over });

test("renders font attributes and one tspan per line", () => {
  const out = textNodeSvg(node({ text: "A\nTop" }), ctx());
  expect(out).toContain('font-family="Arial"');
  expect(out).toContain(`font-size="${7 * PT_TO_PX}"`);
  expect(out).toContain('fill="#000000"');
  expect(out.match(/<tspan/g)).toHaveLength(2);
  expect(out).toContain(">Top</tspan>");
  expect(out).not.toContain("font-weight");
});

test("bold italic", () => {
  const out = textNodeSvg(node({ font: { ...DEFAULT_FONT, weight: "bold", italic: true } }), ctx());
  expect(out).toContain('font-weight="bold"');
  expect(out).toContain('font-style="italic"');
});

test("center align anchors at the box centre", () => {
  const out = textNodeSvg(node({ font: { ...DEFAULT_FONT, align: "center" } }), ctx());
  expect(out).toContain('text-anchor="middle"');
  expect(out).toContain('x="60"');
});

test("escapes text", () => expect(textNodeSvg(node({ text: "a<b" }), ctx())).toContain("a&lt;b"));

test("the first baseline is a font size below the top of the box, and the lines follow at the line height", () => {
  const sizePx = 7 * PT_TO_PX;
  const out = textNodeSvg(node({ text: "a\nb\nc", font: { ...DEFAULT_FONT, lineHeight: 1.5 } }), ctx());
  expect(out).toContain(`<text x="10" y="${20 + sizePx}"`);
  expect(out).toContain('<tspan x="10" dy="0">a</tspan>');
  expect(out).toContain(`<tspan x="10" dy="${1.5 * sizePx}">b</tspan>`);
  expect(out).toContain(`<tspan x="10" dy="${1.5 * sizePx}">c</tspan>`);
  expect(out).toContain('text-anchor="start"');
});

test("right align anchors at the right edge of the box, and every tspan starts there", () => {
  const out = textNodeSvg(node({ text: "a\nb", font: { ...DEFAULT_FONT, align: "right" } }), ctx());
  expect(out).toContain('text-anchor="end"');
  expect(out.match(/x="110"/g)).toHaveLength(3);
});

test("spaces are kept as typed: the <text> preserves white space", () => {
  const out = textNodeSvg(node({ text: "a  b\n  c" }), ctx());
  expect(out).toMatch(/^<text [^>]* xml:space="preserve">/);
  expect(out).toContain(">a  b</tspan>");
  expect(out).toContain(">  c</tspan>");
});

test("empty text is an empty <text> element", () => {
  const out = textNodeSvg(node({ text: "" }), ctx());
  expect(out).toMatch(/^<text [^>]*><\/text>$/);
  expect(out).not.toContain("<tspan");
});

test("any line ending is a line break", () => {
  const out = textNodeSvg(node({ text: "a\r\n\nb\rc" }), ctx());
  expect(out.match(/<tspan/g)).toHaveLength(4);
  expect(out).toContain('dy="0">a</tspan>');
  expect(out).toContain(">c</tspan>");
});

// An empty <tspan> does not apply its dy in renderers (checked in headless Chrome: the line after a blank one came out one
// line below the one before it, not two), so a blank line carries a non-breaking space to have something to place.
test("a blank line is a tspan holding a non-breaking space, so the lines after it keep their place", () => {
  const sizePx = 7 * PT_TO_PX;
  const out = textNodeSvg(node({ text: "a\n\nb" }), ctx());
  expect(out.match(/<tspan/g)).toHaveLength(3);
  expect(out).not.toContain("></tspan>");
  expect(out).toContain('<tspan x="10" dy="0">a</tspan>');
  expect(out).toContain(`<tspan x="10" dy="${1.2 * sizePx}">&#160;</tspan>`);
  expect(out).toContain(`<tspan x="10" dy="${1.2 * sizePx}">b</tspan>`);
});

test("a first or last blank line, and a line of only spaces (which SVG collapses to nothing), are held the same way", () => {
  expect(textNodeSvg(node({ text: "\nb" }), ctx())).toContain('<tspan x="10" dy="0">&#160;</tspan>');
  expect(textNodeSvg(node({ text: "a\n" }), ctx())).toMatch(/>a<\/tspan><tspan [^>]*>&#160;<\/tspan>/);
  const spaces = textNodeSvg(node({ text: "a\n  \t\nb" }), ctx());
  expect(spaces.match(/&#160;/g)).toHaveLength(1);
  expect(spaces).not.toContain("></tspan>");
});

test("a line with text keeps its spaces, and only empty text has no tspans at all", () => {
  expect(textNodeSvg(node({ text: " a b " }), ctx())).toContain('dy="0"> a b </tspan>');
  expect(textNodeSvg(node({ text: "" }), ctx())).not.toContain("<tspan");
});

test("escapes &, < and > in text, and quotes in attributes", () => {
  const out = textNodeSvg(node({ text: 'R&D <b> "x"', font: { ...DEFAULT_FONT, family: 'A"B', color: 'red"/>' } }), ctx());
  expect(out).toContain(">R&amp;D &lt;b&gt; \"x\"</tspan>");
  expect(out).toContain('font-family="A&quot;B"');
  expect(out).toContain('fill="red&quot;/&gt;"');
});

test("does not touch the context", () => {
  const c = ctx();
  textNodeSvg(node(), c);
  expect(c.defs).toEqual([]);
  expect(c.warnings).toEqual([]);
});
