// @vitest-environment happy-dom
// Security (F1, F4, F6, F7, F8): crafted text cannot make a regular expression backtrack for seconds on the main thread.
// Each input is one the report describes, sized so that the old expressions took seconds to minutes; a linear scan takes
// milliseconds, so the bound is loose enough for a slow machine.
import { inlineSvg, svgIntrinsicSize } from "../../src/export/inline-svg";
import { expandFont, prepareFonts, type FaceResolver } from "../../src/export/pdf-fonts";
import { domSvgMeasure } from "../../src/export/trim/svg";
import { MD_LINK } from "../../src/links/intake-classify";
import { parseNote } from "../../src/links/note-drop";

const BOUND_MS = 500;
const elapsed = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const elapsedAsync = async (f: () => Promise<unknown>) => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';

describe("F1: the DOCTYPE of a linked SVG", () => {
  const crafted = `<!-- <!ENTITY --><!DOCTYPE${"[]".repeat(30)}[ ${SVG_OPEN}<rect/></svg>`;

  test("a run of [] pairs with no end is read in linear time", () => {
    expect(elapsed(() => svgIntrinsicSize(crafted))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => inlineSvg(crafted, "p-"))).toBeLessThan(BOUND_MS);
  });

  test("a DOCTYPE with an internal subset is still read, its entities expanded", () => {
    const text = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY w "7"><!ENTITY ns "http://x/">]>${SVG_OPEN.replace("10 10", "&w; 3")}<g a="&ns;"/></svg>`;
    expect(svgIntrinsicSize(text).viewBox).toEqual([0, 0, 7, 3]);
    expect(inlineSvg(text, "p-")).toBe('<g a="http://x/"/>');
  });
});

describe("F4: url( in a linked SVG's attributes and styles", () => {
  test("url( followed by a long run of spaces and no ) is read in linear time", () => {
    const spaces = " ".repeat(1500);
    const text = `${SVG_OPEN}<rect data-x="url(${spaces}"/><style>a{fill:url(${spaces}}</style></svg>`;
    expect(elapsed(() => inlineSvg(text, "p-"))).toBeLessThan(BOUND_MS);
  });

  test("url() values with spaces inside are still read: outside ones go, local ones stay", () => {
    const warnings: string[] = [];
    const out = inlineSvg(`${SVG_OPEN}<rect fill="url(  #g  )" stroke="url( 'https://x/y' )" mask="url(&quot; http://x &quot;)"/></svg>`, "p-", warnings);
    expect(out).toBe('<rect fill="url(#p-g)" stroke="none" mask="none"/>');
    expect(warnings).toEqual(["external reference removed: https://x/y", "external reference removed: http://x"]);
  });
});

describe("F7: url( in a cropped SVG panel being measured", () => {
  test("url( followed by a long run of spaces and no ) is read in linear time", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const text = `${SVG_OPEN}<rect id="r" fill="url(${" ".repeat(1500)}"/></svg>`;
    const el = new DOMParser().parseFromString(text, "image/svg+xml").getElementById("r") as unknown as SVGGraphicsElement;
    expect(elapsed(() => domSvgMeasure(host)(el))).toBeLessThan(BOUND_MS);
    host.remove();
  });
});

describe("F8: font declarations in the PDF font pass", () => {
  const spaces = " ".repeat(30_000);
  const none: FaceResolver = async () => ({ face: null });
  const svgWith = (inner: string) => `${SVG_OPEN}${inner}<text font-family="Arial">a</text></svg>`;

  test.each([
    ["font-weight", `<path style="font-weight:a${spaces}b!" d="M0 0"/>`],
    ["font-style", `<path style="font-style:a${spaces}b!" d="M0 0"/>`],
    ["font-family", `<path style="font-family:a${spaces}b" d="M0 0"/>`],
    ["the font shorthand", `<path style="font:12px a${spaces}b" d="M0 0"/>`],
    ["a long rule without braces", `<style>${"a".repeat(30_000)}</style>`],
    ["a font-family attribute", `<text font-family="a${spaces}b">x</text>`],
  ])("%s with a long run of spaces is read in linear time", async (_what, inner) => {
    expect(await elapsedAsync(() => prepareFonts(svgWith(inner), none))).toBeLessThan(BOUND_MS);
  });

  test("expandFont with a long run of spaces is linear", () => {
    expect(elapsed(() => expandFont(`12px${spaces}a`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => expandFont(`a${spaces}b`))).toBeLessThan(BOUND_MS);
  });

  test("expandFont still reads size / line-height with spaces around the slash", () => {
    expect(expandFont("bold 10px / 1.2 Arial")).toEqual([["font-style", "normal"], ["font-weight", "bold"], ["font-size", "10px"], ["line-height", "1.2"], ["font-family", "Arial"]]);
  });
});

describe("F6: Markdown links on a note's lines", () => {
  const line = `${"[".repeat(300)}](${"a".repeat(2000)}`;

  test("a line of [ then ]( and no ) is read in linear time", () => {
    expect(elapsed(() => [...line.matchAll(MD_LINK)])).toBeLessThan(BOUND_MS);
    expect(elapsed(() => parseNote(`# H\n\n![x](img.png)\n${line}\n`))).toBeLessThan(BOUND_MS);
  });

  test("links are still found as before", () => {
    const found = (text: string) => [...text.matchAll(MD_LINK)].map((m) => [m[0], m[1]]);
    expect(found("![a](b.png) and [c](<d e.md> \"t\") and [f]( g.md 'x' )")).toEqual([
      ["![a](b.png)", "b.png"],
      ['[c](<d e.md> "t")', "<d e.md>"],
      ["[f]( g.md 'x' )", "g.md"],
    ]);
    expect(found("[a](b")).toEqual([]);
  });
});
