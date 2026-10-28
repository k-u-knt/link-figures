// @vitest-environment happy-dom
import { svgIntrinsicSize } from "../../src/export/inline-svg";
import { browserTrimDeps } from "../../src/export/trim";
import { domSvgMeasure, pruneSvg, type SvgMeasure } from "../../src/export/trim/svg";
import type { Rect } from "../../src/model/geometry";

/** The visible region of the 100×100 test sources: the left half. */
const LEFT_HALF: Rect = { x: 0, y: 0, width: 50, height: 100 };
const INSIDE: Rect = { x: 10, y: 10, width: 10, height: 10 };
const OUTSIDE: Rect = { x: 70, y: 10, width: 10, height: 10 };
const CROSSING: Rect = { x: 40, y: 10, width: 20, height: 10 };

/** A measure that answers by element id; an element without an entry measures `null`. */
function measureById(boxes: Record<string, Rect | null>): SvgMeasure {
  return (el) => boxes[el.id] ?? null;
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200" viewBox="0 0 100 100">${body}</svg>`;
}

/** The ids of the elements left in `text`. */
function idsIn(text: string): string[] {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  return Array.from(doc.querySelectorAll("[id]"), (el) => el.id);
}

test("elements wholly outside are removed; crossing, unmeasurable, empty and non-finite ones stay", () => {
  const text = svg(
    `<rect id="in"/><path id="out"/><line id="cross"/><circle id="unknown"/><text id="empty">a</text><ellipse id="nan"/>`,
  );
  const out = pruneSvg(
    text,
    LEFT_HALF,
    measureById({
      in: INSIDE,
      out: OUTSIDE,
      cross: CROSSING,
      empty: { x: 80, y: 10, width: 0, height: 0 },
      nan: { x: 80, y: 10, width: Number.NaN, height: 10 },
    }),
  );
  expect(out.removed).toBe(1);
  expect(idsIn(out.text)).toEqual(["in", "cross", "unknown", "empty", "nan"]);
});

test("an element whose edge only touches the visible region stays", () => {
  const out = pruneSvg(svg(`<rect id="touch"/>`), LEFT_HALF, measureById({ touch: { x: 50, y: 0, width: 10, height: 10 } }));
  expect(out.removed).toBe(0);
});

test("a group left with no drawn children is removed; one with a survivor stays", () => {
  const text = svg(`<g id="gone"><title id="t1">x</title><path id="a"/><path id="b"/></g><g id="kept"><path id="c"/><path id="d"/></g>`);
  const out = pruneSvg(text, LEFT_HALF, measureById({ a: OUTSIDE, b: OUTSIDE, c: OUTSIDE, d: INSIDE }));
  expect(out.removed).toBe(3);
  expect(idsIn(out.text)).toEqual(["kept", "d"]);
});

test("an empty group the source already had is left alone", () => {
  const out = pruneSvg(svg(`<g id="empty"/><path id="a"/>`), LEFT_HALF, measureById({ a: OUTSIDE }));
  expect(idsIn(out.text)).toEqual(["empty"]);
});

test("a definition only a removed element used is removed; ones kept elements use stay, as do style and title", () => {
  const text = svg(
    `<title>Plot</title><style>.k { stroke: url(#css); }</style>` +
      `<defs><linearGradient id="g1"/><linearGradient id="g2"/><linearGradient id="g3"/><linearGradient id="g4"/>` +
      `<linearGradient id="g5" href="#g6"/><linearGradient id="g6"/><linearGradient id="css"/><linearGradient id="unused"/></defs>` +
      `<path id="out" fill="url(#g1)"/><path id="in1" fill="url(#g2)"/><use id="in2" href="#g3"/><use id="in3" xlink:href="#g4"/>` +
      `<rect id="in4" style="fill: url('#g5')"/>`,
  );
  const out = pruneSvg(text, LEFT_HALF, measureById({ out: OUTSIDE, in1: INSIDE, in2: INSIDE, in3: INSIDE, in4: INSIDE }));
  expect(out.removed).toBe(1);
  expect(idsIn(out.text)).toEqual(["g2", "g3", "g4", "g5", "g6", "css", "unused", "in1", "in2", "in3", "in4"]);
  expect(out.text).toContain("<title>Plot</title>");
  expect(out.text).toContain(".k { stroke: url(#css); }");
});

test("a resource declared outside <defs> that only a removed element used is removed too", () => {
  const text = svg(
    `<clipPath id="c1"><rect id="cr"/></clipPath><linearGradient id="g1"/><clipPath id="c2"/><marker id="unused"/>` +
      `<path id="out" clip-path="url(#c1)" fill="url(#g1)"/><path id="in" clip-path="url(#c2)"/>`,
  );
  const out = pruneSvg(text, LEFT_HALF, measureById({ out: OUTSIDE, in: INSIDE }));
  expect(out.removed).toBe(1);
  expect(idsIn(out.text)).toEqual(["c2", "unused", "in"]);
});

test("an element another one uses stays even when it lies outside", () => {
  const text = svg(`<path id="shape"/><use id="copy" href="#shape"/>`);
  const out = pruneSvg(text, LEFT_HALF, measureById({ shape: OUTSIDE, copy: INSIDE }));
  expect(out.removed).toBe(0);
});

test("what is not drawn in place (definitions, clip paths, switch alternatives) is not measured", () => {
  const measured: string[] = [];
  const text = svg(`<defs><path id="d"/></defs><clipPath id="c"><rect id="cr"/></clipPath><switch><rect id="s"/></switch><rect id="r"/>`);
  pruneSvg(text, LEFT_HALF, (el) => {
    measured.push(el.id);
    return null;
  });
  expect(measured).toEqual(["r"]);
});

test("removed counts only drawn elements, and the output re-parses with the same intrinsic size", () => {
  const text = `<?xml version="1.0"?>\n` + svg(`<defs><linearGradient id="g"/></defs><g><rect id="a" fill="url(#g)"/></g><rect id="b"/>`);
  const out = pruneSvg(text, LEFT_HALF, measureById({ a: OUTSIDE, b: INSIDE }));
  expect(out.removed).toBe(1);
  const doc = new DOMParser().parseFromString(out.text, "image/svg+xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  expect(svgIntrinsicSize(out.text)).toEqual(svgIntrinsicSize(text));
});

test("text that is not an SVG cannot be trimmed", () => {
  expect(() => pruneSvg("<html/>", LEFT_HALF, () => null)).toThrow();
});

describe("domSvgMeasure", () => {
  /** Stubs layout: every element's box is `box`, and its matrix to the screen is `matrix` (the root's is `rootMatrix`). */
  function stubLayout(box: Rect, matrix: number[], rootMatrix = [1, 0, 0, 1, 0, 0]) {
    const proto = (window as unknown as { SVGGraphicsElement: { prototype: SVGGraphicsElement } }).SVGGraphicsElement.prototype;
    vi.spyOn(proto, "getBBox").mockImplementation(() => new DOMRect(box.x, box.y, box.width, box.height));
    vi.spyOn(proto, "getScreenCTM").mockImplementation(function (this: SVGGraphicsElement) {
      const m = this.localName === "svg" && !this.parentElement?.closest("svg") ? rootMatrix : matrix;
      return DOMMatrix.fromMatrix({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }) as unknown as DOMMatrix;
    });
  }

  afterEach(() => vi.restoreAllMocks());

  function measureFirst(body: string, id: string): Rect | null {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const doc = new DOMParser().parseFromString(svg(body), "image/svg+xml");
      const el = doc.getElementById(id) as unknown as SVGGraphicsElement;
      return domSvgMeasure(host)(el);
    } finally {
      host.remove();
    }
  }

  test("maps the box through the element's matrix relative to the root", () => {
    stubLayout({ x: 0, y: 0, width: 10, height: 5 }, [2, 0, 0, 2, 30, 40], [2, 0, 0, 2, 10, 20]);
    // Relative to the root: translate(10, 10).
    expect(measureFirst(`<rect id="r" style="stroke: none"/>`, "r")).toEqual({ x: 10, y: 10, width: 10, height: 5 });
  });

  test("widens by half the stroke width, scaled", () => {
    stubLayout({ x: 0, y: 0, width: 10, height: 10 }, [2, 0, 0, 2, 0, 0]);
    expect(measureFirst(`<rect id="r" style="stroke: black; stroke-width: 3"/>`, "r")).toEqual({ x: -3, y: -3, width: 26, height: 26 });
  });

  test("is null under a filter whose region cannot be read", () => {
    stubLayout({ x: 0, y: 0, width: 10, height: 10 }, [1, 0, 0, 1, 0, 0]);
    expect(measureFirst(`<g style="filter: blur(2px)"><rect id="r" style="stroke: none"/></g>`, "r")).toBeNull();
  });

  test("is widened to the filter region of a filter it can read", () => {
    stubLayout({ x: 0, y: 0, width: 10, height: 10 }, [1, 0, 0, 1, 0, 0]);
    const box = measureFirst(`<filter id="f"/><rect id="r" style="stroke: none; filter: url(#f)"/>`, "r");
    // The default region: 10 % beyond the box on every side.
    expect(box!.x).toBeCloseTo(-1);
    expect(box!.y).toBeCloseTo(-1);
    expect(box!.width).toBeCloseTo(12);
    expect(box!.height).toBeCloseTo(12);
  });

  test("prunes the SVG it measured in the host, and the output still reads as the same SVG", () => {
    const proto = (window as unknown as { SVGGraphicsElement: { prototype: SVGGraphicsElement } }).SVGGraphicsElement.prototype;
    vi.spyOn(proto, "getBBox").mockImplementation(function (this: SVGGraphicsElement) {
      const box = this.id === "out" ? OUTSIDE : INSIDE;
      return new DOMRect(box.x, box.y, box.width, box.height);
    });
    vi.spyOn(proto, "getScreenCTM").mockImplementation(() => DOMMatrix.fromMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as unknown as DOMMatrix);
    const text = svg(`<defs><linearGradient id="g"/></defs><rect id="out" fill="url(#g)"/><use id="in" xlink:href="#s"/><symbol id="s"/>`);
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const out = pruneSvg(text, LEFT_HALF, domSvgMeasure(host));
      expect(out.removed).toBe(1);
      expect(idsIn(out.text)).toEqual(["in", "s"]);
      expect(out.text).toContain('xlink:href="#s"');
      expect(svgIntrinsicSize(out.text)).toEqual(svgIntrinsicSize(text));
    } finally {
      host.remove();
    }
  });

  test("widens by the marker's reach in stroke widths, from its reference point", () => {
    stubLayout({ x: 0, y: 0, width: 10, height: 10 }, [1, 0, 0, 1, 0, 0]);
    const marker = `<marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2"/>`;
    const box = measureFirst(`${marker}<path id="p" style="stroke: black; stroke-width: 2; marker-end: url(#m)"/>`, "p");
    // The farthest corner of the 4 × 4 viewport is (2, 2) from the reference point, in stroke widths of 2.
    const reach = Math.hypot(2, 2) * 2;
    expect(box!.x).toBeCloseTo(-reach);
    expect(box!.width).toBeCloseTo(10 + 2 * reach);
  });

  test("widens by the marker's reach in user units, through its viewBox and the element's scale", () => {
    stubLayout({ x: 0, y: 0, width: 10, height: 10 }, [2, 0, 0, 2, 0, 0]);
    // A 0 0 2 2 viewBox fitted into 6 × 6: the reference point (0, 0) lands on the viewport's corner, 6√2 from the far one.
    const marker = `<marker id="m" markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6" viewBox="0 0 2 2"/>`;
    const box = measureFirst(`${marker}<path id="p" style="stroke: none; stroke-width: 5; marker-start: url(#m)"/>`, "p");
    const reach = Math.hypot(6, 6) * 2;
    expect(box!.x).toBeCloseTo(-reach);
    expect(box!.width).toBeCloseTo(20 + 2 * reach);
  });

  test.each([
    ["a missing marker", `<path id="p" style="marker-end: url(#nowhere)"/>`],
    ["a marker whose content may overflow", `<marker id="m" overflow="visible" style="overflow: visible"/><path id="p" style="marker-end: url(#m)"/>`],
    ["a marker with an unreadable viewBox", `<marker id="m" viewBox="0 0 0 2"/><path id="p" style="marker-end: url(#m)"/>`],
    ["a marker size with a unit", `<marker id="m" markerWidth="3mm"/><path id="p" style="marker-end: url(#m)"/>`],
  ])("is null for %s", (_name, body) => {
    stubLayout({ x: 0, y: 0, width: 10, height: 10 }, [1, 0, 0, 1, 0, 0]);
    expect(measureFirst(body, "p")).toBeNull();
  });

  /**
   * A source with what could run or load: event attributes, a script, HTML (in a foreignObject and on its own), links
   * and CSS out of the file. (No `<iframe>`: happy-dom's DOMParser, unlike a browser's, tries to load one.)
   */
  const UNSAFE_SOURCE =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)">` +
    `<style>@import "https://evil.example/a.css"; .a { fill: url(https://evil.example/f.svg#x); }</style>` +
    `<script>alert(2)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject><html:b xmlns:html="http://www.w3.org/1999/xhtml">html</html:b>` +
    `<image id="img" href="https://evil.example/i.png" onerror="alert(3)"/><image id="img2" xlink:href="https://evil.example/j.png"/>` +
    `<rect id="r" style="fill: url('https://evil.example/p.svg#y')"/><rect id="in"/></svg>`;

  /** Prunes `text` measuring with `domSvgMeasure` in a fresh host (`#in` is always inside); returns the result and the host's mounted markup. */
  function pruneInHost(text: string): { out: { text: string; removed: number }; mounted: string | null; boxes: (Rect | null)[] } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const measure = domSvgMeasure(host);
      const boxes: (Rect | null)[] = [];
      const out = pruneSvg(text, LEFT_HALF, (el) => {
        const box = measure(el);
        boxes.push(box);
        return el.id === "in" ? INSIDE : box;
      });
      const first = host.shadowRoot?.firstChild;
      return { out, mounted: first ? new XMLSerializer().serializeToString(first) : null, boxes };
    } finally {
      host.remove();
    }
  }

  test("what reaches the host is a copy without anything that runs or loads; the source is pruned and kept as it was", () => {
    stubLayout(OUTSIDE, [1, 0, 0, 1, 0, 0]);
    const { out, mounted } = pruneInHost(UNSAFE_SOURCE.replace(`@import "https://evil.example/a.css"; `, ""));
    for (const banned of ["onload", "onerror", "script", "foreignObject", "xhtml", "https://", "alert"]) expect(mounted).not.toContain(banned);
    expect(mounted).toContain(".a { fill: none; }");
    expect(mounted).toContain('style="fill: none"');
    expect(out.removed).toBe(3);
    expect(idsIn(out.text)).toEqual(["in"]);
    expect(out.text).toContain("<script>alert(2)</script>");
    expect(out.text).toContain('onload="alert(1)"');
  });

  test("CSS that cannot be made safe (an @import) mounts nothing, and nothing is measured", () => {
    stubLayout(OUTSIDE, [1, 0, 0, 1, 0, 0]);
    const { out, mounted, boxes } = pruneInHost(UNSAFE_SOURCE);
    expect(mounted).toBeNull();
    expect(boxes.every((box) => box === null)).toBe(true);
    expect(out.removed).toBe(0);
  });

  test("is null when the browser cannot measure", () => {
    const proto = (window as unknown as { SVGGraphicsElement: { prototype: SVGGraphicsElement } }).SVGGraphicsElement.prototype;
    vi.spyOn(proto, "getBBox").mockImplementation(() => {
      throw new Error("no layout");
    });
    expect(measureFirst(`<rect id="r"/>`, "r")).toBeNull();
  });
});

test("the browser's SVG trimmer removes its measuring host even when the SVG cannot be read", async () => {
  const before = document.body.childElementCount;
  await expect(browserTrimDeps.trimSvg("<html/>", LEFT_HALF)).rejects.toThrow();
  expect(document.body.childElementCount).toBe(before);
});
