import { inlineSvg, svgIntrinsicSize, svgRootAttributes } from "../../src/export/inline-svg";

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
    expect(svgRootAttributes("")).toBe("");
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
  test("leaves attributes that merely end in id and plain text alone; a link to another document is dropped with a warning", () => {
    const warnings: string[] = [];
    expect(inlineSvg('<svg><g data-id="x" xml:id="y" href="other.svg#x"/><text>id="z" url(#q)</text></svg>', "p-", warnings)).toBe(
      '<g data-id="x" xml:id="y"/><text>id="z" url(#p-q)</text>',
    );
    expect(warnings).toEqual(["external reference removed: other.svg#x"]);
  });
});

describe("inlineSvg: fidelity and safety", () => {
  const svglite =
    "<?xml version='1.0' encoding='UTF-8' ?><svg xmlns='http://www.w3.org/2000/svg' class='svglite' width='72.00pt' height='72.00pt' viewBox='0 0 72.00 72.00'>" +
    "<defs><style type='text/css'><![CDATA[\n    .svglite line, .svglite polyline, .svglite polygon, .svglite path, .svglite rect, .svglite circle {\n      fill: none;\n      stroke: #000000;\n    }\n  ]]></style></defs>" +
    "<rect width='100%' height='100%' style='stroke: none; fill: #FFFFFF;'/><polyline points='1,1 2,2' class='line' style='stroke-width: 1.07;'/></svg>";

  test("svglite: a rule for the root's own class still reaches the root's children, and the CDATA wrapper stays", () => {
    const out = inlineSvg(svglite, "n1-");
    expect(out).toContain("<style type='text/css'><![CDATA[");
    expect(out).toContain("#n1-root .n1-svglite polyline,#n1-root.n1-svglite polyline,");
    expect(out).toContain("#n1-root .n1-svglite circle,#n1-root.n1-svglite circle{");
    expect(out).toContain("fill: none;");
    expect(out).toContain("<polyline points='1,1 2,2' class='n1-line'");
    // Hand-checked against the DOM: `#n1-root.n1-svglite` is the root element (id and class together), `polyline` its child.
  });

  test("a rule for a class the root does not have is scoped to the descendants only", () =>
    expect(inlineSvg('<svg class="a"><style>.st0{fill:red}</style><rect class="st0 st1"/></svg>', "n1-")).toBe(
      '<style>#n1-root .n1-st0{fill:red}</style><rect class="n1-st0 n1-st1"/>',
    ));

  test("a rule for svg also matches the root itself", () =>
    expect(inlineSvg("<svg><style>svg{overflow:hidden}</style></svg>", "n1-")).toBe("<style>#n1-root svg,svg#n1-root{overflow:hidden}</style>"));

  test("the universal selector is scoped, not applied to the whole figure", () =>
    expect(inlineSvg("<svg><style>*{stroke-linecap:butt;stroke-linejoin:round;}</style><g/></svg>", "n1-")).toBe(
      "<style>#n1-root *{stroke-linecap:butt;stroke-linejoin:round;}</style><g/>",
    ));

  test("#id selectors follow the prefixed ids", () =>
    expect(inlineSvg('<svg><style>#bg{fill:red}</style><rect id="bg"/></svg>', "n1-")).toBe(
      '<style>#n1-root #n1-bg{fill:red}</style><rect id="n1-bg"/>',
    ));

  test("selector lists, combinators, pseudo-classes and attribute selectors", () =>
    expect(inlineSvg('<svg><style>g.a > .b, [href$=".png"] #c:not(.d){fill:red}</style></svg>', "n1-")).toBe(
      '<style>#n1-root g.n1-a > .n1-b,#n1-root [href$=".png"] #n1-c:not(.n1-d){fill:red}</style>',
    ));

  test("two files that both use .st0 do not collide", () => {
    const file = (colour: string) => `<svg><style type="text/css">.st0{fill:${colour}}</style><rect class="st0"/></svg>`;
    const a = inlineSvg(file("red"), "a-");
    const b = inlineSvg(file("blue"), "b-");
    expect(a).toBe('<style type="text/css">#a-root .a-st0{fill:red}</style><rect class="a-st0"/>');
    expect(b).toBe('<style type="text/css">#b-root .b-st0{fill:blue}</style><rect class="b-st0"/>');
    expect(a + b).not.toMatch(/[^-]\.st0/);
  });

  test("url() in a style rule is carried over too", () =>
    expect(inlineSvg("<svg><style>.a{fill:url(#g)}</style></svg>", "p-")).toBe("<style>#p-root .p-a{fill:url(#p-g)}</style>"));

  test("at-rules are dropped with one warning each kind, and the rules around them stay", () => {
    const warnings: string[] = [];
    const css = "@import url(x.css);.a{fill:red}@media print{.a{fill:blue}.b{fill:green}}@font-face{font-family:F;src:url(f.woff)}@media screen{.c{x:y}}.d{fill:pink}";
    const out = inlineSvg(`<svg><style>${css}</style></svg>`, "p-", warnings);
    expect(out).toBe("<style>#p-root .p-a{fill:red}#p-root .p-d{fill:pink}</style>");
    expect(warnings).toEqual(["@import rule in <style> dropped", "@media rule in <style> dropped", "@font-face rule in <style> dropped"]);
  });

  test("dropping an at-rule without a warnings array is fine", () =>
    expect(inlineSvg("<svg><style>@media print{.a{x:y}}</style></svg>", "p-")).toBe("<style></style>"));

  test("comments inside a stylesheet are ignored", () =>
    expect(inlineSvg("<svg><style>/* a { } */.a{x:y}</style></svg>", "p-")).toBe("<style>#p-root .p-a{x:y}</style>"));

  test("class attributes are carried over, single- and double-quoted, and extra spaces are collapsed", () =>
    expect(inlineSvg(`<svg><g class="a  b"/><g class='c'/><g data-class="d"/></svg>`, "p-")).toBe(
      `<g class="p-a p-b"/><g class='p-c'/><g data-class="d"/>`,
    ));

  test("a DOCTYPE's entities are expanded, including in the root's attributes, and the DOCTYPE goes", () => {
    const text =
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd" [' +
      '<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/"><!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/"><!ENTITY both "&ns_ai; and &ns_extend;">]>' +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" viewBox="0 0 10 10"><metadata title="&both; &amp; &lt;"/></svg>';
    expect(svgRootAttributes(text)).toBe(' xmlns:x="http://ns.adobe.com/Extensibility/1.0/" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/"');
    expect(inlineSvg(text, "p-")).toBe(
      '<metadata title="http://ns.adobe.com/AdobeIllustrator/10.0/ and http://ns.adobe.com/Extensibility/1.0/ &amp; &lt;"/>',
    );
    expect(svgIntrinsicSize(text)).toMatchObject({ width: 10, height: 10 });
  });

  test("an entity that would grow without bound is not defined", () => {
    const big = "x".repeat(60_000);
    const text = `<!DOCTYPE svg [<!ENTITY a "${big}"><!ENTITY b "&a;&a;">]><svg><g id="&b;"/></svg>`;
    // `b` is over the limit, so it stays an (undeclared) reference instead of becoming 120 kB of text.
    expect(inlineSvg(text, "p-")).toBe('<g id="p-&b;"/>');
  });

  test("scripts, foreignObject and event attributes are removed", () => {
    const out = inlineSvg(
      '<svg onload="evil()"><script>alert(1)</script><g onclick="x()" ONCLICK="no" id="a"/><script href="x.js"/><rect/>' +
        '<foreignObject width="1" height="1"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><FOREIGNOBJECT/><circle onmouseover=\'y()\' r="1"/><script type="text/ecmascript"><![CDATA[ if (a < b) {} ]]></script></svg>',
      "p-",
    );
    expect(out).toBe('<g id="p-a"/><rect/><circle r="1"/>');
  });

  test("an href with any namespace prefix is carried over", () =>
    expect(inlineSvg('<svg><use xl:href="#g"/><use xlink:href="#g"/><image xlink:href="data:x#g"/></svg>', "p-")).toBe(
      '<use xl:href="#p-g"/><use xlink:href="#p-g"/><image xlink:href="data:x#g"/>',
    ));

  test("every quoting of url() is carried over", () =>
    expect(inlineSvg(`<svg><g a="url(&quot;#g&quot;)" b='url("#g")' c="url('#g')" d="url( #g )" e="url(#g)"/></svg>`, "p-")).toBe(
      `<g a="url(&quot;#p-g&quot;)" b='url("#p-g")' c="url('#p-g')" d="url(#p-g)" e="url(#p-g)"/>`,
    ));

  test("a closing tag with space before the > ends the root", () => expect(inlineSvg("<svg><g/></svg ><!-- after -->", "p-")).toBe("<g/>"));
});

describe("svgRootAttributes", () => {
  test("is everything the nested element does not set itself, in source order", () =>
    expect(
      svgRootAttributes(
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="r" x="1" y="2" width="3" height="4" viewBox="0 0 1 1" preserveAspectRatio="none" version="1.1" class="svglite" fill='none' style="stroke:url(#g)" xml:space="preserve"/>`,
        "n1-",
      ),
    ).toBe(' xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" class="n1-svglite" fill="none" style="stroke:url(#n1-g)" xml:space="preserve"'));

  test("without a prefix class names and references stay as they are", () =>
    expect(svgRootAttributes('<svg class="a b" style="fill:url(#g)"/>')).toBe(' class="a b" style="fill:url(#g)"'));

  test("event attributes are dropped whatever their case, and quotes in values are escaped", () =>
    expect(svgRootAttributes(`<svg onload="x()" onClick='y()' font-family='"Times New Roman"'/>`)).toBe(' font-family="&quot;Times New Roman&quot;"'));

  test("is empty when there is nothing to carry", () => {
    expect(svgRootAttributes('<svg viewBox="0 0 1 1"/>')).toBe("");
    expect(svgRootAttributes("not svg")).toBe("");
  });
});

describe("inlineSvg: what the export must not run or fetch", () => {
  test("script and foreignObject under a namespace prefix are removed, self-closing or not", () =>
    expect(
      inlineSvg(
        '<svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script><g/>' +
          '<x:foreignObject width="1"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></x:foreignObject><svg:script href="x.js"/><a.b-c:script>y()</a.b-c:script><rect/></svg>',
        "p-",
      ),
    ).toBe("<g/><rect/>"));

  test("removal is repeated until nothing changes, so a removed element cannot leave another behind", () => {
    expect(inlineSvg("<svg><scr<script></script>ipt>alert(1)</script><g/></svg>", "p-")).toBe("<g/>");
    expect(inlineSvg("<svg><foreign<svg:script/>Object>x</foreignObject><g/></svg>", "p-")).toBe("<g/>");
    expect(inlineSvg("<svg><scr<!-- -->ipt>alert(1)</script><g/></svg>", "p-")).toBe("<g/>");
  });

  test("a javascript: href, under any prefix and with any spacing or case, is dropped", () => {
    const warnings: string[] = [];
    const out = inlineSvg(
      `<svg><a href="javascript:alert(1)"><g/></a><a xlink:href=' JavaScript:x()'/><a ns:href="javascript:y"/><use href="#g"/></svg>`,
      "p-",
      warnings,
    );
    expect(out).toBe('<a><g/></a><a/><a/><use href="#p-g"/>');
    expect(out).not.toMatch(/javascript/i);
    expect(warnings).toEqual([
      "external reference removed: javascript:alert(1)",
      "external reference removed: JavaScript:x()",
      "external reference removed: javascript:y",
    ]);
  });

  test("an href that is not #… or data:… is dropped with one warning per value; fragments and data stay", () => {
    const warnings: string[] = [];
    const out = inlineSvg(
      '<svg><image href="http://example.com/a.png"/><image xlink:href="plot.png"/><image href="http://example.com/a.png"/>' +
        '<image href="data:image/png;base64,AAAA"/><use xlink:href="#g"/></svg>',
      "p-",
      warnings,
    );
    expect(out).toBe('<image/><image/><image/><image href="data:image/png;base64,AAAA"/><use xlink:href="#p-g"/>');
    expect(warnings).toEqual(["external reference removed: http://example.com/a.png", "external reference removed: plot.png"]);
  });

  test("a url() that leaves the document becomes none, in attributes, style attributes and style rules alike", () => {
    const warnings: string[] = [];
    const out = inlineSvg(
      `<svg><style>.a{fill:url(https://x.org/p.svg#p)}.b{fill:url(#g)}</style>` +
        `<rect fill="url(http://a/b)" style="background:url('http://c/d.png');stroke:url(&quot;e.svg#f&quot;)" mask="url(data:image/png;base64,AA)"/><g filter='url("#f")'/></svg>`,
      "p-",
      warnings,
    );
    expect(out).toBe(
      `<style>#p-root .p-a{fill:none}#p-root .p-b{fill:url(#p-g)}</style>` +
        `<rect fill="none" style="background:none;stroke:none" mask="url(data:image/png;base64,AA)"/><g filter='url("#p-f")'/>`,
    );
    expect(warnings).toEqual([
      "external reference removed: https://x.org/p.svg#p",
      "external reference removed: http://a/b",
      "external reference removed: http://c/d.png",
      "external reference removed: e.svg#f",
    ]);
  });

  test("a long reference is shown cut to 80 characters", () => {
    const warnings: string[] = [];
    const url = `http://example.com/${"x".repeat(100)}`;
    inlineSvg(`<svg><image href="${url}"/></svg>`, "p-", warnings);
    expect(warnings).toEqual([`external reference removed: ${url.slice(0, 80)}…`]);
  });

  test("the url() of an at-rule that is dropped anyway is not reported", () => {
    const warnings: string[] = [];
    inlineSvg("<svg><style>@import url(http://x/y.css);@font-face{src:url(f.woff)}.a{x:y}</style></svg>", "p-", warnings);
    expect(warnings).toEqual(["@import rule in <style> dropped", "@font-face rule in <style> dropped"]);
  });

  test("the root's own attributes lose their references out too", () => {
    const warnings: string[] = [];
    expect(svgRootAttributes(`<svg href="http://x/" xlink:href="#a" style="background:url(http://y/z.png)" fill="url(#g)"/>`, "p-", warnings)).toBe(
      ' xlink:href="#a" style="background:none" fill="url(#p-g)"',
    );
    expect(warnings).toEqual(["external reference removed: http://x/", "external reference removed: http://y/z.png"]);
  });
});

describe("inlineSvg: entity expansion", () => {
  test("expansion adds at most 2 MB to the document; past that the references stay as they are, with a warning", () => {
    const warnings: string[] = [];
    const big = "x".repeat(90_000);
    // 30 references of 90 kB each would add 2.7 MB: the first 23 (2.07 MB) fit, the rest are left.
    const text = `<!DOCTYPE svg [<!ENTITY a "${big}">]><svg><text>${"&a;".repeat(30)}</text></svg>`;
    const out = inlineSvg(text, "p-", warnings);
    expect(out.length).toBeLessThanOrEqual(text.length + 2 * 1024 * 1024);
    expect(out.split(big).length - 1).toBe(23);
    expect(out.match(/&a;/g)).toHaveLength(7);
    expect(warnings).toEqual(["entity expansion stopped at 2 MB; the remaining references were left as they are"]);
  });

  test("expansion under the limit warns of nothing", () => {
    const warnings: string[] = [];
    expect(inlineSvg(`<!DOCTYPE svg [<!ENTITY a "b">]><svg><g id="&a;"/></svg>`, "p-", warnings)).toBe('<g id="p-b"/>');
    expect(warnings).toEqual([]);
  });
});
