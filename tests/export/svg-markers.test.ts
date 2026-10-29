// @vitest-environment happy-dom
import { jsPDF } from "jspdf";
// The package's `main` is a UMD bundle that looks for a global jsPDF; its ES build patches the imported one.
import "svg2pdf.js/dist/svg2pdf.es.js";
import { normaliseUserSpaceMarkers } from "../../src/export/svg-markers";

const SVG_MIME = "image/svg+xml";
const ARROW = '<marker id="a" markerWidth="8" markerHeight="8" refX="2" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 z"/></marker>';

const svg = (defs: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs>${defs}</defs>${body}</svg>`;
const parse = (text: string) => new DOMParser().parseFromString(text, SVG_MIME);
const markers = (doc: Document) => Array.from(doc.getElementsByTagName("marker"));
const byId = (doc: Document, id: string) => markers(doc).find((m) => m.getAttribute("id") === id);

test("a userSpaceOnUse marker at stroke 2 is drawn from a clone half its size, with a viewBox of the original's size", () => {
  const doc = parse(normaliseUserSpaceMarkers(svg(ARROW, '<path id="p" d="M0,0 L50,0" stroke="#000" stroke-width="2" marker-end="url(#a)"/>')));
  const clone = byId(doc, "a-lfsw1");
  expect(clone?.getAttribute("markerWidth")).toBe("4");
  expect(clone?.getAttribute("markerHeight")).toBe("4");
  expect(clone?.getAttribute("viewBox")).toBe("0 0 8 8");
  expect(clone?.getAttribute("refX")).toBe("2");
  expect(clone?.querySelector("path")?.getAttribute("d")).toBe("M0,0 L8,4 L0,8 z");
  expect(doc.getElementById("p")?.getAttribute("marker-end")).toBe("url(#a-lfsw1)");
  // The original stays as it was.
  expect(byId(doc, "a")?.getAttribute("markerWidth")).toBe("8");
  expect(byId(doc, "a")?.hasAttribute("viewBox")).toBe(false);
});

test("the same marker at strokes 2 and 4 gets one clone per width, and a second use at 2 shares the first clone", () => {
  const doc = parse(
    normaliseUserSpaceMarkers(
      svg(
        ARROW,
        '<path id="p" d="M0,0 L50,0" stroke-width="2" marker-end="url(#a)"/><path id="q" d="M0,0 L50,0" stroke-width="4" marker-start="url(#a)"/><path id="r" d="M0,0 L50,0" stroke-width="2" marker-mid="url(#a)"/>',
      ),
    ),
  );
  expect(markers(doc)).toHaveLength(3);
  expect(doc.getElementById("p")?.getAttribute("marker-end")).toBe("url(#a-lfsw1)");
  expect(doc.getElementById("q")?.getAttribute("marker-start")).toBe("url(#a-lfsw2)");
  expect(doc.getElementById("r")?.getAttribute("marker-mid")).toBe("url(#a-lfsw1)");
  expect(byId(doc, "a-lfsw2")?.getAttribute("markerWidth")).toBe("2");
});

test("at stroke 1, or with no stroke width (1 by default), the SVG is returned unchanged", () => {
  for (const attrs of ['stroke-width="1"', ""]) {
    const input = svg(ARROW, `<path d="M0,0 L50,0" ${attrs} marker-end="url(#a)"/>`);
    expect(normaliseUserSpaceMarkers(input)).toBe(input);
  }
});

test("a strokeWidth-unit marker is left alone, explicit or by default", () => {
  for (const units of ['markerUnits="strokeWidth"', ""]) {
    const input = svg(`<marker id="a" markerWidth="3" markerHeight="3" ${units}><path d="M0,0 L3,1.5 L0,3 z"/></marker>`, '<path d="M0,0 L50,0" stroke-width="2" marker-end="url(#a)"/>');
    expect(normaliseUserSpaceMarkers(input)).toBe(input);
  }
});

test("a marker with a viewBox of its own keeps it", () => {
  const doc = parse(
    normaliseUserSpaceMarkers(
      svg('<marker id="a" viewBox="0 0 10 10" markerWidth="8" markerHeight="6" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z"/></marker>', '<path d="M0,0 L50,0" stroke-width="2" marker-end="url(#a)"/>'),
    ),
  );
  const clone = byId(doc, "a-lfsw1");
  expect(clone?.getAttribute("viewBox")).toBe("0 0 10 10");
  expect([clone?.getAttribute("markerWidth"), clone?.getAttribute("markerHeight")]).toEqual(["4", "3"]);
});

test("a stroke width inherited from a <g>, or set in the style attribute, is honoured", () => {
  const doc = parse(
    normaliseUserSpaceMarkers(
      svg(
        ARROW,
        '<g stroke-width="4"><g><path id="p" d="M0,0 L50,0" marker-end="url(#a)"/></g></g><g style="stroke-width: 2"><path id="q" d="M0,0 L50,0" style="marker-end: url(&quot;#a&quot;)"/></g>',
      ),
    ),
  );
  expect(doc.getElementById("p")?.getAttribute("marker-end")).toBe("url(#a-lfsw1)");
  expect(byId(doc, "a-lfsw1")?.getAttribute("markerWidth")).toBe("2");
  expect(doc.getElementById("q")?.getAttribute("style")).toContain("marker-end: url(#a-lfsw2)");
  expect(byId(doc, "a-lfsw2")?.getAttribute("markerWidth")).toBe("4");
});

test("the element's own stroke width wins over its ancestors', the style attribute over the presentation attribute", () => {
  const doc = parse(
    normaliseUserSpaceMarkers(svg(ARROW, '<g stroke-width="4"><path id="p" d="M0,0 L50,0" stroke-width="3" style="stroke-width:2" marker-end="url(#a)"/></g>')),
  );
  expect(byId(doc, "a-lfsw1")?.getAttribute("markerWidth")).toBe("4");
});

test("a percentage, non-numeric or zero stroke width leaves the element alone", () => {
  for (const width of ["50%", "thick", "0"]) {
    const input = svg(ARROW, `<path d="M0,0 L50,0" stroke-width="${width}" marker-end="url(#a)"/>`);
    expect(normaliseUserSpaceMarkers(input)).toBe(input);
  }
});

test("a clone's id never takes one the document already uses", () => {
  const doc = parse(normaliseUserSpaceMarkers(svg(`${ARROW}<g id="a-lfsw1"/>`, '<path id="p" d="M0,0 L50,0" stroke-width="2" marker-end="url(#a)"/>')));
  expect(doc.getElementById("p")?.getAttribute("marker-end")).toBe("url(#a-lfsw2)");
});

test("svg2pdf.js draws the rewritten marker at a unit scale, so the 8×8 arrowhead stays 8×8", async () => {
  // The Cowork reproduction: test-vault/Notes/crop-test.svg's arrow at stroke 2, which came out as `2 0 0 2 148 45 cm`.
  const source = svg(ARROW, '<path d="M100,45 L148,45" stroke="#000" stroke-width="2" marker-end="url(#a)"/>');
  /** The marker form's scale in the PDF: the `cm` before its `Do`, or null when there is none. */
  const markerScale = async (text: string) => {
    const pdf = new jsPDF({ unit: "px", format: [200, 120], compress: false, hotfixes: ["px_scaling"] });
    await pdf.svg(parse(text).documentElement, { x: 0, y: 0, width: 200, height: 120 });
    const content = pdf.output();
    const placed = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/\S+ Do/.exec(content);
    // The form's /Matrix carries the viewBox scale.
    const form = /\/Matrix \[([^\]]+)\]/.exec(content);
    if (!placed || !form) return null;
    const outer = Math.hypot(Number(placed[1]), Number(placed[2]));
    const inner = Number(form[1].trim().split(/\s+/)[0]);
    return outer * inner;
  };
  expect(await markerScale(source)).toBeCloseTo(2, 6);
  expect(await markerScale(normaliseUserSpaceMarkers(source))).toBeCloseTo(1, 6);
});
