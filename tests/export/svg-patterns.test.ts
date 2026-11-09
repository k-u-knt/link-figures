// @vitest-environment happy-dom
import { normalisePatternOrigins } from "../../src/export/svg-patterns";

const svg = (pattern: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs>${pattern}</defs><rect width="9" height="9" fill="url(#p)"/></svg>`;
const pattern = (attributes: string) => `<pattern id="p" width="8" height="8" ${attributes}><path d="M0 8 L8 0" stroke="#000000"/></pattern>`;
const patternOf = (text: string) => new DOMParser().parseFromString(text, "image/svg+xml").getElementsByTagName("pattern")[0];

describe("normalisePatternOrigins", () => {
  test("moves x and y into a translate of the pattern's transform", () => {
    const p = patternOf(normalisePatternOrigins(svg(pattern('patternUnits="userSpaceOnUse" x="30" y="40"'))));
    expect(p.getAttribute("x")).toBe("0");
    expect(p.getAttribute("y")).toBe("0");
    expect(p.getAttribute("patternTransform")).toBe("translate(30 40)");
  });

  test("puts the translate after an existing patternTransform", () => {
    const p = patternOf(normalisePatternOrigins(svg(pattern('patternUnits="userSpaceOnUse" x="30" y="40" patternTransform="rotate(15 30 40)"'))));
    expect(p.getAttribute("patternTransform")).toBe("rotate(15 30 40) translate(30 40)");
  });

  test("reads px and a single absent offset", () => {
    const p = patternOf(normalisePatternOrigins(svg(pattern('patternUnits="userSpaceOnUse" x="5px"'))));
    expect(p.getAttribute("patternTransform")).toBe("translate(5 0)");
  });

  test.each([
    ["x and y at 0", 'patternUnits="userSpaceOnUse" x="0" y="0"'],
    ["no x or y", 'patternUnits="userSpaceOnUse"'],
    ["a percentage", 'patternUnits="userSpaceOnUse" x="10%" y="5"'],
    ["another unit", 'patternUnits="userSpaceOnUse" x="3" y="2mm"'],
    ["no patternUnits", 'x="30" y="40"'],
    ["objectBoundingBox units", 'patternUnits="objectBoundingBox" x="0.1" y="0.2"'],
    ["href", 'patternUnits="userSpaceOnUse" x="30" y="40" href="#q"'],
    ["xlink:href", 'patternUnits="userSpaceOnUse" x="30" y="40" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#q"'],
  ])("leaves a pattern with %s as it is", (_name, attributes) => {
    const input = svg(pattern(attributes));
    expect(normalisePatternOrigins(input)).toBe(input);
  });

  test("returns text that cannot be parsed as it is", () => {
    const input = '<svg userSpaceOnUse><pattern patternUnits="userSpaceOnUse" x="1"';
    expect(normalisePatternOrigins(input)).toBe(input);
  });
});
