import { inlineSvg, svgIntrinsicSize, svgRootNamespaces } from "../../src/export/inline-svg";

test("intrinsic size from viewBox", () =>
  expect(svgIntrinsicSize('<svg viewBox="0 0 200 100" width="10mm"/>')).toEqual({ width: 200, height: 100, viewBox: [0, 0, 200, 100] }));

test("intrinsic size from pt width/height", () =>
  expect(svgIntrinsicSize('<svg width="72pt" height="36pt"/>')).toEqual({ width: 96, height: 48, viewBox: [0, 0, 96, 48] }));

test("inlineSvg prefixes ids and references and strips the prolog", () => {
  const out = inlineSvg(
    '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use xlink:href="#g"/><use href="#g"/></svg>',
    "n1-",
  );
  expect(out).toBe('<defs><linearGradient id="n1-g"/></defs><rect fill="url(#n1-g)"/><use xlink:href="#n1-g"/><use href="#n1-g"/>');
});

// Beyond the brief's three.

describe("svgIntrinsicSize", () => {
  test("no size at all is 300x150", () => expect(svgIntrinsicSize("<svg/>")).toEqual({ width: 300, height: 150, viewBox: [0, 0, 300, 150] }));
  test("plain numbers are px; mm, cm, in and pc convert at 96 dpi", () => {
    expect(svgIntrinsicSize('<svg width="40" height="20px"/>').width).toBe(40);
    const inch = svgIntrinsicSize('<svg width="1in" height="2.54cm"/>');
    expect([inch.width, inch.height]).toEqual([96, 96]);
    const mm = svgIntrinsicSize('<svg width="25.4mm" height="1pc"/>');
    expect(mm.width).toBeCloseTo(96, 9);
    expect(mm.height).toBe(16);
  });
  test("a percentage or unknown unit counts as absent", () =>
    expect(svgIntrinsicSize('<svg width="100%" height="2em"/>')).toMatchObject({ width: 300, height: 150 }));
  test("viewBox keeps its origin and accepts commas and single quotes", () =>
    expect(svgIntrinsicSize("<svg viewBox='-5,-10, 50,25'/>")).toEqual({ width: 50, height: 25, viewBox: [-5, -10, 50, 25] }));
  test("a degenerate viewBox falls back to width and height", () =>
    expect(svgIntrinsicSize('<svg viewBox="0 0 0 0" width="30" height="10"/>')).toEqual({ width: 30, height: 10, viewBox: [0, 0, 30, 10] }));
  test("reads the root tag past a prolog, DOCTYPE and comments, and ignores nested svg elements", () =>
    expect(
      svgIntrinsicSize('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><!-- <svg width="1"> --><svg width="20" height="10"><svg width="1" height="1"/></svg>'),
    ).toMatchObject({ width: 20, height: 10 }));
  test("a byte order mark before the prolog is skipped", () =>
    expect(svgIntrinsicSize('\uFEFF<?xml version="1.0"?>\n<svg width="20" height="10"/>')).toMatchObject({ width: 20, height: 10 }));
  test("text that is not an SVG file gets the default size and no inlined content", () => {
    expect(svgIntrinsicSize("<html><svg width='1'/></html>")).toMatchObject({ width: 300, height: 150 });
    expect(inlineSvg("<html><svg width='1'><g/></svg></html>", "p-")).toBe("");
    expect(svgRootNamespaces("")).toBe("");
  });
  test("an attribute value containing > does not end the tag", () =>
    expect(svgIntrinsicSize('<svg data-x="a>b" width="20" height="10"/>')).toMatchObject({ width: 20, height: 10 }));
});

describe("inlineSvg", () => {
  test("returns the child markup of the root, leaving nested svg elements and whitespace inside intact", () =>
    expect(inlineSvg('<svg width="1">\n  <svg><g/></svg>\n</svg>\n', "p-")).toBe("<svg><g/></svg>"));
  test("a self-closing root has no children", () => expect(inlineSvg('<svg width="1"/>', "p-")).toBe(""));
  test("removes comments and a DOCTYPE with an internal subset", () =>
    expect(inlineSvg('<!DOCTYPE svg [ <!ENTITY a "b"> ]><svg><!-- gone --><g/></svg>', "p-")).toBe("<g/>"));
  test("rewrites single-quoted attributes and quoted or spaced url() references", () =>
    expect(inlineSvg(`<svg><g id='a' fill="url( #a )" stroke='url("#a")' style="fill:url('#a')" xlink:href='#a'/></svg>`, "p-")).toBe(
      `<g id='p-a' fill="url(#p-a)" stroke='url("#p-a")' style="fill:url('#p-a')" xlink:href='#p-a'/>`,
    ));
  test("url() inside a <style> block is rewritten too", () =>
    expect(inlineSvg("<svg><style>.a{fill:url(#g)}</style></svg>", "p-")).toBe("<style>.a{fill:url(#p-g)}</style>"));
  test("leaves attributes that merely end in id, links to other documents and plain text alone", () =>
    expect(inlineSvg('<svg><g data-id="x" xml:id="y" href="other.svg#x"/><text>id="z" url(#q)</text></svg>', "p-")).toBe(
      '<g data-id="x" xml:id="y" href="other.svg#x"/><text>id="z" url(#p-q)</text>',
    ));
});

describe("svgRootNamespaces", () => {
  test("lists the xmlns:prefix declarations of the root, not the default namespace", () =>
    expect(svgRootNamespaces('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape=\'urn:i\'><g/></svg>')).toBe(
      ' xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="urn:i"',
    ));
  test("is empty when there are none", () => expect(svgRootNamespaces('<svg viewBox="0 0 1 1"/>')).toBe(""));
});
