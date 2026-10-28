import { MM_TO_PX, IMAGE_EXTENSIONS, FILE_SUFFIX, DEFAULT_PAGE_LIMIT_MM, normalisePageLimit } from "../src/constants";
test("mm to px at 96 dpi", () => expect(MM_TO_PX).toBeCloseTo(3.7795, 4));
test("svg counts as an image", () => expect(IMAGE_EXTENSIONS).toContain("svg"));
test("suffix", () => expect(FILE_SUFFIX).toBe(".lnkfig.md"));
test("a stored page limit is clamped into 100-5000 mm, and a non-number is the default", () => {
  expect(normalisePageLimit(50)).toBe(100);
  expect(normalisePageLimit(9000)).toBe(5000);
  expect(normalisePageLimit(1500)).toBe(1500);
  expect(normalisePageLimit("lots")).toBe(DEFAULT_PAGE_LIMIT_MM);
  expect(normalisePageLimit(undefined)).toBe(2000);
  expect(normalisePageLimit(NaN)).toBe(2000);
});
