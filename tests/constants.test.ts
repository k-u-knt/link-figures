import { MM_TO_PX, IMAGE_EXTENSIONS, FILE_SUFFIX } from "../src/constants";
test("mm to px at 96 dpi", () => expect(MM_TO_PX).toBeCloseTo(3.7795, 4));
test("svg counts as an image", () => expect(IMAGE_EXTENSIONS).toContain("svg"));
test("suffix", () => expect(FILE_SUFFIX).toBe(".lnkfig.md"));
