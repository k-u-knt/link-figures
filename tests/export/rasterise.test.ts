import { paperBackground, sizedSvg } from "../../src/export/rasterise";

test("the root's width and height become the pixel size, the viewBox and the rest left as they were", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="183mm" height="170mm" viewBox="0 0 691.65 642.52"><rect width="10" height="10"/></svg>';
  expect(sizedSvg(svg, 2161, 2008)).toBe(
    '<svg width="2161" height="2008" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 691.65 642.52"><rect width="10" height="10"/></svg>',
  );
});

test("a root with no width or height gets them", () => {
  expect(sizedSvg('<svg viewBox="0 0 1 1"/>', 3, 4)).toBe('<svg width="3" height="4" viewBox="0 0 1 1"/>');
});

test("a prolog before the root is kept", () => {
  expect(sizedSvg('<?xml version="1.0"?>\n<svg width="1mm" height="2mm"></svg>', 5, 6)).toBe('<?xml version="1.0"?>\n<svg width="5" height="6"></svg>');
});

test("text that is not an SVG is refused", () => {
  expect(() => sizedSvg("<html/>", 1, 1)).toThrow(/no <svg> root/);
});

test("the paper is the background, white when it is transparent", () => {
  expect(paperBackground("#123456")).toBe("#123456");
  expect(paperBackground("transparent")).toBe("#ffffff");
  expect(paperBackground("none")).toBe("#ffffff");
  expect(paperBackground("")).toBe("#ffffff");
});
