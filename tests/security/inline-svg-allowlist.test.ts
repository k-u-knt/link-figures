// Security (F5, F9): what an inlined SVG keeps is decided by an allowlist of SVG elements, not a denylist.
import { inlineSvg, svgRootAttributes } from "../../src/export/inline-svg";

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const inline = (body: string, root = `<svg ${SVG_NS}>`) => inlineSvg(`${root}${body}</svg>`, "p-");

describe("elements outside SVG", () => {
  test.each([
    ['<iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/>'],
    ['<iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
    ['<h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/>'],
    ['<embed src="https://evil.example/x.swf"/>'],
    ['<object data="https://evil.example/x"/>'],
    ['<handler type="application/ecmascript">alert(1)</handler>'],
    ['<g xmlns="http://www.w3.org/1999/xhtml"><iframe src="javascript:alert(1)"/></g>'],
  ])("%s is dropped with what it holds", (body) => {
    const out = inline(`${body}<rect/>`);
    expect(out).toBe("<rect/>");
  });

  test("an element whose prefix binds a namespace other than SVG is dropped, even with an SVG element's name", () => {
    expect(inline('<h:a xmlns:h="http://www.w3.org/1999/xhtml"><h:style>.a{}</h:style></h:a><rect/>')).toBe("<rect/>");
  });

  test("a prefix the root binds to another namespace is not taken for SVG", () => {
    expect(inline('<h:a>x</h:a><rect/>', `<svg ${SVG_NS} xmlns:h="http://www.w3.org/1999/xhtml">`)).toBe("<rect/>");
  });

  test("an SVG element under any prefix bound to the SVG namespace is kept", () => {
    expect(inline('<s:rect width="1"/>', `<svg xmlns:s="http://www.w3.org/2000/svg">`)).toBe('<s:rect width="1"/>');
    expect(inline('<g xmlns:t="http://www.w3.org/2000/svg"><t:circle r="1"/></g>')).toBe('<g xmlns:t="http://www.w3.org/2000/svg"><t:circle r="1"/></g>');
  });

  test("a prefix bound inside one element does not reach past its end", () => {
    expect(inline('<g xmlns:t="http://www.w3.org/2000/svg"></g><t:circle r="1"/><rect/>')).toBe('<g xmlns:t="http://www.w3.org/2000/svg"></g><rect/>');
  });

  test("editor metadata elements (Inkscape, Illustrator, RDF) are dropped; the drawing stays", () => {
    const out = inline(
      '<sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" pagecolor="#fff"/>' +
        '<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><cc:Work xmlns:cc="http://creativecommons.org/ns#"/></rdf:RDF></metadata>' +
        '<g><path d="M0 0L1 1"/><text x="1">a<tspan>b</tspan></text></g>',
    );
    expect(out).toBe('<metadata></metadata><g><path d="M0 0L1 1"/><text x="1">a<tspan>b</tspan></text></g>');
  });

  test("ordinary SVG content is kept as it was", () => {
    const body =
      '<defs><linearGradient id="g"><stop offset="0"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="1"/></filter>' +
      '<clipPath id="c"><rect/></clipPath><marker id="m"><path/></marker><pattern id="pt"/><mask id="k"/><symbol id="s"/></defs>' +
      '<use href="#s"/><image href="data:image/png;base64,QQ=="/><ellipse/><line/><polygon/><polyline/><title>t</title><desc>d</desc>' +
      '<switch><g/></switch><animateTransform attributeName="transform" type="rotate" to="90"/><animate attributeName="opacity" to="0"/>';
    expect(inline(body)).toBe(body.replace(/id="(\w+)"/g, 'id="p-$1"').replace('href="#s"', 'href="#p-s"'));
  });
});

describe("animations", () => {
  test.each(["href", "xlink:href", " HREF "])("<set> or <animate> that changes %s is dropped", (attr) => {
    expect(inline(`<a><set attributeName="${attr}" to="javascript:alert(1)"/><animate attributeName="${attr}" values="javascript:alert(1)"/><rect/></a>`)).toBe(
      "<a><rect/></a>",
    );
  });

  test("an animation of another attribute stays, its outside url() made none", () => {
    expect(inline('<set attributeName="fill" to="url(https://evil.example/x)"/>')).toBe('<set attributeName="fill" to="none"/>');
  });
});

describe("attributes", () => {
  test("xml:base is dropped", () => {
    expect(inline('<a xml:base="javascript:alert(1)//"><rect/></a>')).toBe("<a><rect/></a>");
    expect(svgRootAttributes(`<svg ${SVG_NS} xml:base="https://evil.example/"/>`)).toBe("");
  });

  test("the root's namespace declarations are carried as they are (the content check resolves them)", () => {
    expect(svgRootAttributes(`<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h="http://www.w3.org/1999/xhtml"/>`)).toBe(
      ' xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h="http://www.w3.org/1999/xhtml"',
    );
  });
});
